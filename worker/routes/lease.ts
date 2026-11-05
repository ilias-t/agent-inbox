// meta/lease: which manager session owns the inbox. Every write is pinned on
// the version read in the same request, so two acquirers can't both win.

import { LEASE_SESSION_HEADER, LEASE_SESSION_MAX, type Doc, type Lease, type Schedule } from "../../shared/types.ts";
import { requireFull, requireFullRole, type Caller } from "../auth.ts";
import { badRequest, conflict, ifVersion, json, optString, reqString } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { getDoc, mutate } from "../store.ts";
import { scheduleView } from "./schedule.ts";

const TTL_MIN_DEFAULT = 25;
const TTL_MAX = 300;

// Explicit ttl_min, else long enough to survive one pickup interval plus
// slack, so a manager on a slow schedule doesn't lose the lease between ticks.
async function ttlMin(c: Ctx, body: Record<string, unknown>): Promise<number> {
  const v = body.ttl_min;
  if (v === undefined || v === null) {
    const { schedule } = scheduleView(await getDoc<Schedule>(c.env.DB, "meta", "schedule"));
    return Math.max(TTL_MIN_DEFAULT, schedule.pickup_interval_min + 15);
  }
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > TTL_MAX) {
    throw badRequest(`ttl_min must be an integer 1-${TTL_MAX}`);
  }
  return v as number;
}

const isFresh = (lease: Doc<Lease>, nowMs: number) => Date.parse(lease.data.expires_at) > nowMs;

const held = (cur: Doc<Lease> | null) =>
  conflict("lease_held", cur ? `Lease held by ${cur.data.holder_session_id}` : "No lease", cur);

// Throws lease_held unless `session` holds a fresh lease now. A write that hands over something only the holder may
// take (claim's re-take) calls it after reading what it writes, so a session that lost the lease since its request was
// checked can't take back what the new holder took (the new holder took the lease first).
export async function requireHeld(db: D1Database, session: string, now: string): Promise<void> {
  const cur = await getDoc<Lease>(db, "meta", "lease");
  if (cur?.data.holder_session_id === session && isFresh(cur, Date.parse(now))) return;
  throw held(cur);
}

// Opt-in lease check on writes (docs/api.md "Lease-checked writes"). A
// manager-token write that names its session in X-Lease-Session lands only
// while that session holds a fresh lease. Reads, the lease endpoints (their
// own session_id rules apply), humans and orchestrator tokens are never
// checked. One read when the request arrives, so a batch is checked once.
export async function checkLeaseSession(
  db: D1Database,
  request: Request,
  path: string,
  caller: Caller,
  now: string,
): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD") return;
  if (path === "/lease" || path.startsWith("/lease/")) return;
  const p = caller.principal;
  if (p.kind !== "token" || p.scope !== "manager") return;
  const session = request.headers.get(LEASE_SESSION_HEADER);
  if (session === null) return;
  if (!session || session.length > LEASE_SESSION_MAX) {
    throw badRequest(`${LEASE_SESSION_HEADER} must be 1-${LEASE_SESSION_MAX} chars`);
  }
  const cur = await getDoc<Lease>(db, "meta", "lease");
  if (cur?.data.holder_session_id === session && isFresh(cur, Date.parse(now))) return;
  if (cur?.data.holder_session_id === session) {
    throw conflict("lease_held", `Lease for ${session} expired at ${cur.data.expires_at}: renew it`, cur);
  }
  throw held(cur);
}

async function get(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  const lease = await getDoc<Lease>(c.env.DB, "meta", "lease");
  const nowMs = Date.parse(c.now);
  return json({ lease, expired: lease ? !isFresh(lease, nowMs) : false, now: c.now });
}

async function acquire(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "admin"); // humans: admins only
  const body = await c.body();
  const sessionId = reqString(body, "session_id", 200);
  const title = optString(body, "title", 500);
  const url = optString(body, "url", 2000);
  const ttl = await ttlMin(c, body);
  const pin = ifVersion(body.if_version);
  const force = body.force === true;
  const nowMs = Date.parse(c.now);

  const { doc } = await mutate<Lease>(c.env.DB, "meta", "lease", { actor: c.caller.actor, now: c.now }, (cur) => {
    const mine = cur?.data.holder_session_id === sessionId;
    if (cur && !mine && isFresh(cur, nowMs)) {
      // Steal: the caller proves it saw the lease it is replacing.
      if (!(force && pin === cur.version)) throw held(cur);
    } else if (pin !== undefined && pin !== (cur?.version ?? 0)) {
      throw conflict("conflict", `Version mismatch: have ${cur?.version ?? 0}, if_version ${pin}`, cur);
    }
    const lease: Lease = {
      holder_session_id: sessionId,
      holder_title: title ?? (mine ? cur?.data.holder_title : undefined),
      holder_url: url ?? (mine ? cur?.data.holder_url : undefined),
      acquired_at: mine && cur ? cur.data.acquired_at : c.now,
      heartbeat_at: c.now,
      expires_at: new Date(nowMs + ttl * 60_000).toISOString(),
    };
    return lease;
  });
  return json({ lease: doc, acquired: true });
}

async function renew(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "admin"); // humans: admins only
  const body = await c.body();
  const sessionId = reqString(body, "session_id", 200);
  const ttl = await ttlMin(c, body);
  const pin = ifVersion(body.if_version);
  const { doc } = await mutate<Lease>(c.env.DB, "meta", "lease", { actor: c.caller.actor, now: c.now }, (cur) => {
    // Holder first: a lost lease is lease_held (step down), not a retryable conflict.
    if (!cur || cur.data.holder_session_id !== sessionId) throw held(cur);
    if (pin !== undefined && pin !== cur.version) {
      throw conflict("conflict", `Version mismatch: have ${cur.version}, if_version ${pin}`, cur);
    }
    return {
      ...cur.data,
      heartbeat_at: c.now,
      expires_at: new Date(Date.parse(c.now) + ttl * 60_000).toISOString(),
    };
  });
  return json({ lease: doc });
}

async function release(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "admin"); // humans: admins only
  const sessionId = reqString(await c.body(), "session_id", 200);
  // One statement: delete only while this session holds it.
  const row = await c.env.DB.prepare(
    `DELETE FROM docs WHERE collection = 'meta' AND id = 'lease'
     AND json_extract(data, '$.holder_session_id') = ? RETURNING version`,
  )
    .bind(sessionId)
    .first();
  if (!row) throw held(await getDoc<Lease>(c.env.DB, "meta", "lease"));
  return json({ ok: true });
}

export const leaseRoutes: Route[] = [
  ["GET", "/lease", get],
  ["POST", "/lease/acquire", acquire],
  ["POST", "/lease/renew", renew],
  ["POST", "/lease/release", release],
];
