// ntfy push (optional) and its signed lock-screen action buttons. Publishing
// runs in waitUntil and never fails the request that triggered it.

import { baseChoices } from "../../shared/choices.ts";
import type { Doc, Item, QaMessage } from "../../shared/types.ts";
import type { Env } from "../env.ts";
import { checkId, hmacHex, HttpError, json, safeEqual, unauthorized } from "../http.ts";
import type { Ctx } from "../router.ts";
import { decideItem } from "../routes/items.ts";
import { actingTopics } from "../users.ts";

// The asks that push when created (ntfy and Web Push alike).
export const NOTIFY_TYPES = new Set(["proposal", "decision", "blocker", "pr_ready"]);
const ACTION_TTL_S = 7 * 24 * 3600;

// `created` is the item doc's created_at, so a link can't decide a later item
// that reuses the id; `version` is the doc version the push showed, so a link
// can't decide content written after it (any later write retires it).
export function signDecide(
  secret: string,
  item: string,
  choice: string,
  exp: number,
  created: string,
  version: number,
): Promise<string> {
  return hmacHex(secret, `${item}|${choice}|${exp}|${created}|${version}`);
}

function baseUrl(c: Ctx): string {
  return (c.env.PUBLIC_URL || c.url.origin).replace(/\/+$/, "");
}

// Up to two of the page's choices (so decide accepts every link), recommendation
// first. An implied ack gets no button: the push is for real asks.
function actionChoices(item: Item): { id: string; label: string }[] {
  const { list, implied } = baseChoices(item);
  const options = implied && item.type !== "proposal" ? [] : list.map((o) => ({ id: o.id, label: o.label }));
  const rec = item.recommendation?.option ?? item.recommended;
  return [...options].sort((a, b) => Number(b.id === rec) - Number(a.id === rec)).slice(0, 2);
}

// The assignee's own topic when they set one. Otherwise (unassigned, or an
// assignee without a topic) every person's topic plus NTFY_TOPIC, so someone
// who can act hears about it. Without any topics that is NTFY_TOPIC alone.
// Viewers' topics never count: the decide buttons work for whoever taps them.
export async function pushTopics(env: Env, item: Item): Promise<string[]> {
  const topics = await actingTopics(env);
  const own = item.assignee ? topics.get(item.assignee) : undefined;
  const all = own ? [own] : [...topics.values(), env.NTFY_TOPIC];
  return [...new Set(all.filter((t): t is string => typeof t === "string" && t !== ""))];
}

async function publish(env: Env, topic: string, message: Record<string, unknown>): Promise<void> {
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  // JSON publishing goes to the server root with the topic in the body.
  const res = await fetch(`${server}/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, ...message }),
  });
  if (!res.ok) console.error("ntfy publish", res.status, await res.text().catch(() => ""));
}

// One message, built once (the signed links are the same for every topic).
function send(c: Ctx, item: Item, build: () => Promise<Record<string, unknown>>): void {
  c.ctx.waitUntil(
    (async () => {
      const topics = await pushTopics(c.env, item);
      if (!topics.length) return;
      const message = await build();
      await Promise.all(topics.map((t) => publish(c.env, t, message)));
    })().catch((e) => console.error("ntfy", e)),
  );
}

export function notifyItemCreated(c: Ctx, doc: Doc<Item>): void {
  if (!NOTIFY_TYPES.has(doc.data.type)) return;
  send(c, doc.data, () => itemMessage(c, doc));
}

// Who a write that may have reassigned `doc` should push to: the new assignee
// of an open ask, unless the caller assigned it to themselves. Else null.
export function reassignTarget(c: Ctx, doc: Doc<Item>, prevAssignee: string | undefined): string | null {
  const item = doc.data, to = item.assignee;
  if (!to || to === prevAssignee || item.status !== "open" || !NOTIFY_TYPES.has(item.type)) return null;
  if (c.caller.actor.toLowerCase() === `human:${to}`) return null;
  return to;
}

// A reassign pushes an open ask to its new assignee's own topic only: everyone
// else already heard about it when it was created. Nothing when they have no
// topic or are a viewer, or when they assigned it to themselves.
export function notifyReassigned(c: Ctx, doc: Doc<Item>, prevAssignee: string | undefined): void {
  const item = doc.data, to = reassignTarget(c, doc, prevAssignee);
  if (!to) return;
  c.ctx.waitUntil(
    (async () => {
      const topic = (await actingTopics(c.env)).get(to);
      if (!topic) return;
      const message = await itemMessage(c, doc);
      await publish(c.env, topic, { ...message, title: `Assigned to you: ${item.title}` });
    })().catch((e) => console.error("ntfy", e)),
  );
}

// An Open button, then the signed decide buttons for `doc` as written (its
// version) while it is still an open ask.
async function itemActions(c: Ctx, doc: Doc<Item>): Promise<Record<string, unknown>[]> {
  const base = baseUrl(c);
  const actions: Record<string, unknown>[] = [{ action: "view", label: "Open", url: `${base}/#item.${doc.id}` }];
  const secret = c.env.NTFY_ACTION_SECRET;
  if (!secret || doc.data.status !== "open" || !NOTIFY_TYPES.has(doc.data.type)) return actions;
  const exp = Math.floor(Date.now() / 1000) + ACTION_TTL_S;
  const ver = doc.version;
  for (const o of actionChoices(doc.data)) {
    const sig = await signDecide(secret, doc.id, o.id, exp, doc.created_at, ver);
    const q = new URLSearchParams({ item: doc.id, choice: o.id, exp: String(exp), created: doc.created_at, ver: String(ver), sig });
    actions.push({ action: "http", label: o.label, url: `${base}/hooks/ntfy/decide?${q}`, method: "POST", clear: true });
  }
  return actions;
}

// An item's push: its question, an Open button and the signed decide buttons.
async function itemMessage(c: Ctx, doc: Doc<Item>): Promise<Record<string, unknown>> {
  const item = doc.data;
  const view = `${baseUrl(c)}/#item.${doc.id}`;
  const actions = await itemActions(c, doc);
  return {
    title: item.title,
    message: item.question || item.title,
    click: view,
    priority: item.priority === "high" ? 4 : 3,
    actions,
  };
}

// The answer bumped the item's version, retiring the buttons pushed before it,
// so the answer carries fresh ones signed for the item as it now stands.
export function notifyAnswer(c: Ctx, item: Doc<Item>, msg: Doc<QaMessage>): void {
  send(c, item.data, async () => ({
    title: `Answer: ${item.data.title}`,
    message: msg.data.text.slice(0, 1000),
    click: `${baseUrl(c)}/#item.${item.id}`,
    actions: await itemActions(c, item),
  }));
}

// POST /hooks/ntfy/decide?item&choice&exp&created&ver&sig: the same atomic
// decide as the API, refused with not_open if the item was decided or
// recreated since signing, and with conflict if it was written since (ver).
// Links from before `ver` existed are refused (401): they are the ones that
// could approve edited content, and they expire within ACTION_TTL_S anyway.
export async function ntfyDecide(request: Request, env: Env): Promise<Response> {
  const secret = env.NTFY_ACTION_SECRET;
  if (!secret) throw new HttpError(503, "unavailable", "NTFY_ACTION_SECRET is not set");
  const q = new URL(request.url).searchParams;
  const item = q.get("item") ?? "";
  const choice = q.get("choice") ?? "";
  const exp = Number(q.get("exp"));
  const created = q.get("created") ?? "";
  const ver = Number(q.get("ver") || NaN);
  const sig = (q.get("sig") ?? "").toLowerCase();
  if (!item || !choice || !created || !Number.isInteger(exp) || !Number.isInteger(ver) || ver < 1) {
    throw unauthorized("Bad action link");
  }
  const expected = await signDecide(secret, item, choice, exp, created, ver);
  if (!safeEqual(sig, expected)) throw unauthorized("Bad signature");
  if (exp < Date.now() / 1000) throw unauthorized("Action link expired");
  checkId(item);
  const doc = await decideItem(env, item, choice, "via ntfy", "hook:ntfy", new Date().toISOString(), { createdAt: created, version: ver });
  return json({ ok: true, status: doc.data.status });
}
