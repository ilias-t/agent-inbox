// Fleets (docs/api.md "Fleets"): which fleet a doc a caller writes belongs to, and the `?fleet=` filter.
// A token is bound to one fleet (auth.ts fleetScope); humans see and write every fleet.

import { DEFAULT_FLEET, FLEET_ID_RE } from "../shared/types.ts";
import { fleetScope, requireFleet, type Caller } from "./auth.ts";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./http.ts";
import type { Ctx } from "./router.ts";
import { getDoc, type DeletePin } from "./store.ts";

// A fleet id from the API ("default" or a named fleet) as stored: null for the default fleet. 400 otherwise.
export function parseFleet(v: unknown, what = "fleet"): string | null {
  if (v === DEFAULT_FLEET) return null;
  if (typeof v !== "string" || !FLEET_ID_RE.test(v)) throw badRequest(`${what} must be "default" or a fleet id (lowercase letters, digits and -, up to 32)`);
  return v;
}

// Sets `next.fleet` for an item or manager doc write, after checking the caller may write `cur` (null: a
// create). A token's writes stay in its own fleet: 403 on another fleet's doc, and whatever the body says,
// the result is the token's fleet (no key for the default fleet). A human (an admin: the only humans who
// write these fields) may set it, which moves the doc; a replace (`replace`) that leaves it out keeps the
// stored one, and a value the write leaves unchanged is kept as stored.
export function stampFleet(c: Caller, cur: object | null, next: Record<string, unknown>, replace: boolean, what = "Item"): void {
  const f = fleetScope(c);
  const stored = cur !== null && Object.hasOwn(cur, "fleet");
  const was = stored ? (cur as Record<string, unknown>).fleet : undefined;
  // The default fleet stores no key, but a stored `fleet: null` (an import's) is kept: it reads as the default
  // fleet too, and dropping it would count as a change to a decided item's content.
  const toDefault = () => {
    if (stored && was === null) next.fleet = null;
    else delete next.fleet;
  };
  if (f !== undefined) {
    if (cur !== null) requireFleet(c, cur, what);
    if (f === null) toDefault();
    else next.fleet = f;
    return;
  }
  if (replace && stored && !Object.hasOwn(next, "fleet")) next.fleet = was;
  if (!Object.hasOwn(next, "fleet")) return;
  const v = next.fleet;
  if (v === null || v === DEFAULT_FLEET) toDefault();
  else if (!(stored && v === was)) next.fleet = parseFleet(v); // a value the write leaves unchanged is kept as stored
}

// The `?fleet=` filter a human may pass to a list (null: the default fleet, undefined: every fleet). A
// token's own fleet is forced, whatever it passes.
export function fleetFilter(c: Caller, q: URLSearchParams): string | null | undefined {
  const own = fleetScope(c);
  if (own !== undefined) return own;
  const raw = q.get("fleet");
  return raw === null ? undefined : parseFleet(raw, "The fleet filter");
}

// A delete by a token only of its own fleet's doc: it reads the doc, checks its fleet (before the caller's pin,
// so a 409 never carries another fleet's doc), and deletes the very doc it read: that version and created_at. A
// write in between, a move included, makes it read again, unless the caller pinned a version: then 409. Humans
// delete as asked. `del` vets the doc it hands back in a 409 the same way.
export async function deleteInFleet(
  c: Ctx,
  collection: string,
  id: string,
  asked: number | undefined,
  del: (pin: DeletePin) => Promise<"deleted" | "missing">,
  what: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let pin: DeletePin = { version: asked };
    if (fleetScope(c.caller) !== undefined) {
      const cur = await getDoc(c.env.DB, collection, id);
      if (!cur) throw notFound(`No ${what.toLowerCase()} ${id}`);
      requireFleet(c.caller, cur.data, what);
      // Always the version it checked: a pin on another one (a later version, which a move may be about to
      // write) is a 409 here, with the doc it checked.
      if (asked !== undefined && asked !== cur.version) {
        throw conflict("conflict", `Version mismatch: have ${cur.version}, if_version ${asked}`, cur);
      }
      pin = { version: cur.version, createdAt: cur.created_at };
    }
    try {
      if ((await del(pin)) === "missing") throw notFound(`No ${what.toLowerCase()} ${id}`);
      return;
    } catch (e) {
      // Our own pin lost a race: read again (the caller's own pin stands, as for any write).
      if (asked !== undefined || pin.version === undefined || attempt >= 4 || !(e instanceof HttpError && e.status === 409)) throw e;
    }
  }
}


// The change rows (`changes`, migration 0012) a fleet's orchestrator token sees. The default fleet's are the
// rows with no fleet at all, so with one fleet that is every row, as before fleets (and one range of the
// changes_fleet index). A named fleet's (`p` binds it) are its own, and the deployment-wide rows, which log no
// fleet: people, shared meta docs (the schedule a fleet falls back on among them; not the default fleet's
// manager and lease), and a person's own snoozes and pins (which only that person ever gets).
export const fleetChangesSql = (named: boolean, p: string) => (named ? `(fleet = ${p} OR (${SHARED_CHANGES}))` : "fleet IS NULL");

// The deployment-wide change rows: the condition of migration 0012's partial index changes_shared, word for word
// (so a query that names it can read that index), less the default fleet's own manager and lease, which the index
// still holds and the query drops.
export const SHARED_CHANGES =
  "fleet IS NULL AND collection IN ('users', 'meta', 'snoozes', 'pins') AND NOT (collection = 'meta' AND doc_id IN ('manager', 'lease'))";

// A per-fleet meta doc's id is `<base>:<fleet>` (`manager:side-a`), and migration 0012 logs its changes under that
// fleet. The fleet it names: null for `<base>:default`, undefined for any other id (a doc every fleet shares).
const PER_FLEET_META = /^(manager|lease|schedule):(.*)$/;
export function metaFleet(id: string): { base: string; fleet: string | null } | undefined {
  const m = PER_FLEET_META.exec(id);
  return m ? { base: m[1], fleet: m[2] === DEFAULT_FLEET ? null : m[2] } : undefined;
}

// A token reads and writes another fleet's per-fleet meta doc never: 403. `<base>:default` is no id at all (the
// default fleet's is the bare `<base>`), so it is 400 for everyone.
export function requireMetaFleet(c: Caller, id: string): void {
  const own = fleetScope(c), named = metaFleet(id);
  if (named && named.fleet === null) throw badRequest(`The default fleet's is meta/${named.base}`);
  if (named) parseFleet(named.fleet, `The fleet in meta/${id}`);
  if (own !== undefined && named && named.fleet !== own) throw forbidden(`meta/${id} belongs to another fleet`);
}

// --- Per-fleet lease, status and work hours (docs/api.md "Fleets") ----------------------------------------------

export type MetaBase = "manager" | "lease" | "schedule";

// A fleet's own copy of a per-fleet meta doc: the bare id (`meta/lease`) for the default fleet, as before fleets.
export const metaId = (base: MetaBase, fleet: string | null) => (fleet === null ? base : `${base}:${fleet}`);

// The fleet a lease, schedule or tick-request call acts on: a token's own (one that names another fleet is 403),
// or the one a person names, else the default fleet. A fleet may be named in `?fleet=` or in the body's `fleet`
// (`default` or a fleet id); naming two different ones is 400, so a fleet put in the other place is never
// silently the default fleet's.
export function targetFleet(c: Ctx, body?: Record<string, unknown>): string | null {
  const fromQuery = c.url.searchParams.get("fleet");
  const q = fromQuery === null ? undefined : parseFleet(fromQuery);
  const b = body?.fleet === undefined || body.fleet === null ? undefined : parseFleet(body.fleet);
  if (q !== undefined && b !== undefined && q !== b) throw badRequest("?fleet= and the body's fleet name different fleets");
  const named = q !== undefined ? q : b;
  const own = fleetScope(c.caller);
  if (own === undefined) return named ?? null;
  if (named !== undefined && named !== own) throw forbidden("That is another fleet's");
  return own;
}

// The id a meta route reads or writes for `id`: a named fleet's token names its own fleet's manager, lease and
// schedule by their bare ids, so its calls stay what they were before fleets. Every other id is as given.
export function resolveMetaId(c: Caller, id: string): string {
  const f = fleetScope(c);
  return f && (id === "manager" || id === "lease" || id === "schedule") ? metaId(id, f) : id;
}

// --- The fleet registry (docs/api.md "Fleets registry") ----------------------------------------------------------

// 400 unless a fleet a person named is registered (a `fleets/<id>` doc exists); the default fleet (null) always is.
// Fleets are never deleted (there is no DELETE /api/fleets), so this read before a write can't be outdated by the
// time the write lands: keep it that way, or every caller of this needs the check inside its write.
export async function requireRegistered(db: D1Database, fleet: string | null): Promise<void> {
  if (fleet === null) return;
  const row = await db.prepare("SELECT 1 AS ok FROM docs WHERE collection = 'fleets' AND id = ?").bind(fleet).first();
  if (!row) throw badRequest(`No fleet ${fleet}: create it first (Settings, or PUT /api/fleets/${fleet})`);
}

// A fleet a person names for a route (targetFleet's or fleetFilter's result) checked against the registry; a
// token's own (forced, checked when it was minted) passes, as does "every fleet" (undefined).
export async function registeredTarget<F extends string | null | undefined>(c: Ctx, fleet: F): Promise<F> {
  if (fleet !== undefined && fleetScope(c.caller) === undefined) await requireRegistered(c.env.DB, fleet);
  return fleet;
}

// For a person's write of an item or manager doc (inside its build, after stampFleet): a move to another fleet
// must name a registered one. A value the write leaves as stored passes, registered or not.
export async function requireMoveRegistered(c: Ctx, cur: object | null, next: Record<string, unknown>): Promise<void> {
  if (fleetScope(c.caller) !== undefined || !Object.hasOwn(next, "fleet")) return;
  const to = next.fleet;
  if (to === null || to === undefined) return;
  if (cur !== null && Object.hasOwn(cur, "fleet") && (cur as Record<string, unknown>).fleet === to) return;
  await requireRegistered(c.env.DB, to as string);
}

// A named fleet in a person's per-fleet meta id (`meta/manager:fa`) must be registered before it is written.
export async function requireMetaRegistered(c: Ctx, id: string): Promise<void> {
  const named = metaFleet(id);
  if (named && fleetScope(c.caller) === undefined) await requireRegistered(c.env.DB, named.fleet);
}
