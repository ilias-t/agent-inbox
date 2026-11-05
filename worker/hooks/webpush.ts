// Web Push to the devices people enabled in Settings (push_subscriptions),
// alongside ntfy. Routed like per-person ntfy topics, viewers included (no
// decide buttons here): the assignee's devices when they have any, otherwise
// everyone's. Item pushes run in
// waitUntil and never fail the request that triggered them. The payload is
// encrypted to each device (RFC 8291), so the push service can't read it.

import type { Doc, Item, QaMessage } from "../../shared/types.ts";
import type { Env } from "../env.ts";
import { HttpError } from "../http.ts";
import { normalizedEndpoint, pushEndpoint } from "../push-endpoint.ts";
import type { Ctx } from "../router.ts";
import { checkVapidKeys, encryptPayload, generateVapidKeys, vapidAuthorization, type VapidKeys } from "../webpush.ts";
import { NOTIFY_TYPES, reassignTarget } from "./ntfy.ts";

// What the service worker shows (public/sw.js): title, body, the page to open, and
// the tag that makes a newer push about the same item replace the older one.
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface SendResult {
  sent: number;
  failed: number;
  removed: number;
}

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const TTL_S = 24 * 3600; // an ask pushed while the phone is off still arrives within a day
const MAX_PAYLOAD = 3000; // bytes of JSON; well under the 4 KB push services take
const enc = new TextEncoder();

// --- Keys ----------------------------------------------------------------------

// The secrets when both are set; otherwise the pair generated on first use and
// kept in D1. Two isolates racing on the first use both insert-or-ignore, then
// read back the one that won.
export async function vapidKeys(env: Env): Promise<VapidKeys> {
  const pub = env.VAPID_PUBLIC_KEY?.trim(), priv = env.VAPID_PRIVATE_KEY?.trim();
  if (pub || priv) {
    if (!pub || !priv) throw new HttpError(503, "unavailable", "Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither");
    const keys = { publicKey: pub, privateKey: priv };
    try {
      checkVapidKeys(keys);
    } catch (e) {
      throw new HttpError(503, "unavailable", `VAPID keys: ${(e as Error).message}`);
    }
    return keys;
  }
  const read = () =>
    env.DB.prepare("SELECT public_key, private_key FROM vapid_keys WHERE id = 1").first<{ public_key: string; private_key: string }>();
  let row = await read();
  if (!row) {
    const fresh = await generateVapidKeys();
    await env.DB.prepare("INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)")
      .bind(fresh.publicKey, fresh.privateKey, new Date().toISOString())
      .run();
    row = await read();
  }
  if (!row) throw new Error("vapid_keys: no row after insert");
  return { publicKey: row.public_key, privateKey: row.private_key };
}

// The contact push services see in the VAPID token (Apple requires one).
function subject(env: Env, origin: string): string {
  return env.VAPID_SUBJECT?.trim() || (env.PUBLIC_URL || origin).replace(/\/+$/, "");
}

// --- Delivery ------------------------------------------------------------------

// A subscription that fails this many pushes in a row is deleted: a device
// that is gone for good but whose push service never said so (404/410).
export const MAX_FAILS = 10;

// The push service says this subscription was made with another VAPID key, so
// no push signed with ours can ever reach it. RFC 8292 §4.2 has push services
// reject that, "403 (Forbidden) might be used"; Apple answers 403 with reason
// VapidPkHashMismatch, FCM 403 "...does not correspond to the sender ID used to
// subscribe this user". Mozilla answers 404 (gone anyway). Any other 403 (a bad
// JWT, a bad VAPID_SUBJECT) is our configuration, not the device: it only counts.
function keyMismatch(status: number, text: string): boolean {
  return status === 403 && /VapidPkHashMismatch|does not correspond to the sender ID/i.test(text);
}

// Deletes the subscriptions whose endpoint no longer passes the push endpoint
// rule (worker/push-endpoint.ts with today's PUSH_ENDPOINT_HOSTS): rows stored
// before the allowlist, or under a host since dropped from it. Each deletion
// logs the host only: the full endpoint is a capability to push to the device.
// Returns the rest, and how many rows this call deleted.
export async function dropDisallowed<T extends { id: number; endpoint: string }>(
  env: Env,
  subs: T[],
): Promise<{ kept: T[]; removed: number }> {
  const kept: T[] = [], bad: T[] = [];
  for (const s of subs) (pushEndpoint(s.endpoint, env.PUSH_ENDPOINT_HOSTS) ? kept : bad).push(s);
  if (!bad.length) return { kept, removed: 0 };
  const db = env.DB;
  const deleted = await db.batch<{ id: number }>(
    bad.map((s) => db.prepare("DELETE FROM push_subscriptions WHERE id = ? RETURNING id").bind(s.id)),
  );
  let removed = 0;
  bad.forEach((s, i) => {
    if (!deleted[i].results.length) return; // a concurrent send deleted it first
    removed++;
    console.warn("webpush: deleted a subscription on a host that isn't an allowed push service:", normalizedEndpoint(s.endpoint)?.host ?? "(not a URL)");
  });
  return { kept, removed };
}

// Sends one payload to each subscription, then records the outcome: a 404 or
// 410 (or a 403 VAPID key mismatch) means the subscription is gone (deleted),
// anything else that isn't 2xx counts against it (a redirect too: push
// services don't redirect, so one isn't followed), and a success clears the
// count. MAX_FAILS in a row deletes it. A subscription whose endpoint no
// longer passes the endpoint rule is deleted without a push (dropDisallowed).
export async function deliver(
  env: Env,
  origin: string,
  stored: SubRow[],
  payload: PushPayload,
  urgency: "normal" | "high" = "normal",
): Promise<SendResult> {
  const { kept: subs, removed } = await dropDisallowed(env, stored);
  const result: SendResult = { sent: 0, failed: 0, removed };
  if (!subs.length) return result;
  const keys = await vapidKeys(env);
  const sub = subject(env, origin);
  const body = enc.encode(JSON.stringify(payload));
  const outcomes = await Promise.all(
    subs.map(async (s): Promise<"ok" | "gone" | "fail"> => {
      try {
        const res = await fetch(s.endpoint, {
          method: "POST",
          headers: {
            Authorization: await vapidAuthorization(s.endpoint, keys, sub),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(TTL_S),
            Urgency: urgency,
          },
          body: await encryptPayload(body, s),
          redirect: "manual",
        });
        const text = res.ok ? "" : await res.text().catch(() => "");
        if (res.ok) return "ok";
        if (res.status === 404 || res.status === 410 || keyMismatch(res.status, text)) return "gone";
        console.error("webpush", new URL(s.endpoint).host, res.status, text.slice(0, 200));
        return "fail";
      } catch (e) {
        console.error("webpush", new URL(s.endpoint).host, e);
        return "fail";
      }
    }),
  );
  const now = new Date().toISOString();
  const db = env.DB;
  const writes = outcomes.map((o, i) => {
    const id = subs[i].id;
    if (o === "ok") {
      result.sent++;
      return db.prepare("UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?").bind(now, id);
    }
    if (o === "gone") {
      result.removed++;
      return db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id);
    }
    result.failed++;
    return db.prepare("UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ? RETURNING fail_count").bind(id);
  });
  const counts = await db.batch<{ fail_count?: number }>(writes);
  const prune = subs.filter((_, i) => outcomes[i] === "fail" && (counts[i].results[0]?.fail_count ?? 0) >= MAX_FAILS);
  if (prune.length) {
    await db.batch(prune.map((s) => db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(s.id)));
    result.failed -= prune.length;
    result.removed += prune.length;
  }
  return result;
}

const COLS = "id, endpoint, p256dh, auth";

export async function subscriptionsOf(env: Env, email: string): Promise<SubRow[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM push_subscriptions WHERE email = ? ORDER BY id`)
    .bind(email.toLowerCase())
    .all<SubRow>();
  return results;
}

// The assignee's devices when they have any; otherwise (unassigned, or an
// assignee who hasn't enabled a device) everyone's.
async function recipients(env: Env, item: Item): Promise<SubRow[]> {
  if (item.assignee) {
    const own = await subscriptionsOf(env, item.assignee);
    if (own.length) return own;
  }
  return (await env.DB.prepare(`SELECT ${COLS} FROM push_subscriptions ORDER BY id`).all<SubRow>()).results;
}

// --- Payloads ------------------------------------------------------------------

function cut(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// Title and body trimmed for a lock screen, then shortened further if the JSON
// (escapes and multi-byte text included) would still be over MAX_PAYLOAD bytes.
export function fitPayload(p: PushPayload): PushPayload {
  let out = { ...p, title: cut(p.title, 120), body: cut(p.body, 600) };
  while (enc.encode(JSON.stringify(out)).length > MAX_PAYLOAD) {
    if (out.body.length > 1) out = { ...out, body: cut(out.body, Math.floor(out.body.length * 0.75)) };
    else out = { ...out, title: cut(out.title, Math.floor(out.title.length * 0.75)) };
  }
  return out;
}

function itemPayload(doc: Doc<Item>, title: string, body: string): PushPayload {
  return fitPayload({ title, body, url: `/#item.${doc.id}`, tag: doc.id });
}

const urgencyOf = (item: Item) => (item.priority === "high" ? "high" : "normal");

// --- Item events (called next to the ntfy ones, worker/notify.ts) ----------------

function background(c: Ctx, work: () => Promise<unknown>): void {
  c.ctx.waitUntil(work().catch((e) => console.error("webpush", e)));
}

export function webPushItemCreated(c: Ctx, doc: Doc<Item>): void {
  const item = doc.data;
  if (!NOTIFY_TYPES.has(item.type)) return;
  background(c, async () =>
    deliver(c.env, c.url.origin, await recipients(c.env, item), itemPayload(doc, item.title, item.question || item.title), urgencyOf(item)),
  );
}

// Like ntfy: an open ask reassigned to someone else goes to their devices only.
export function webPushReassigned(c: Ctx, doc: Doc<Item>, prevAssignee: string | undefined): void {
  const to = reassignTarget(c, doc, prevAssignee);
  if (!to) return;
  const item = doc.data;
  background(c, async () =>
    deliver(
      c.env,
      c.url.origin,
      await subscriptionsOf(c.env, to),
      itemPayload(doc, `Assigned to you: ${item.title}`, item.question || item.title),
      urgencyOf(item),
    ),
  );
}

export function webPushAnswer(c: Ctx, item: Doc<Item>, msg: Doc<QaMessage>): void {
  background(c, async () =>
    deliver(c.env, c.url.origin, await recipients(c.env, item.data), itemPayload(item, `Answer: ${item.data.title}`, msg.data.text)),
  );
}

export async function sendTest(c: Ctx, email: string): Promise<SendResult> {
  return deliver(c.env, c.url.origin, await subscriptionsOf(c.env, email), {
    title: "Test notification",
    body: "Agent Inbox notifications reach this device.",
    url: "/#settings",
    tag: "test",
  });
}
