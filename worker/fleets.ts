// Fleets (docs/api.md "Fleets"): which fleet a doc a caller writes belongs to, and the `?fleet=` filter.
// A token is bound to one fleet (auth.ts fleetScope); humans see and write every fleet.

import { DEFAULT_FLEET, FLEET_ID_RE } from "../shared/types.ts";
import { fleetScope, requireFleet, type Caller } from "./auth.ts";
import { badRequest, HttpError, notFound } from "./http.ts";
import type { Ctx } from "./router.ts";
import { getDoc } from "./store.ts";

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
  if (f !== undefined) {
    if (cur !== null) requireFleet(c, cur, what);
    if (f === null) delete next.fleet;
    else next.fleet = f;
    return;
  }
  const stored = cur !== null && Object.hasOwn(cur, "fleet");
  const was = stored ? (cur as Record<string, unknown>).fleet : undefined;
  if (replace && stored && !Object.hasOwn(next, "fleet")) next.fleet = was;
  if (!Object.hasOwn(next, "fleet") || (stored && next.fleet === was)) return;
  const v = next.fleet === null ? null : parseFleet(next.fleet);
  if (v === null) delete next.fleet;
  else next.fleet = v;
}

// The `?fleet=` filter a human may pass to a list (null: the default fleet, undefined: every fleet). A
// token's own fleet is forced, whatever it passes.
export function fleetFilter(c: Caller, q: URLSearchParams): string | null | undefined {
  const own = fleetScope(c);
  if (own !== undefined) return own;
  const raw = q.get("fleet");
  return raw === null ? undefined : parseFleet(raw, "The fleet filter");
}

// A delete by a token only of its own fleet's doc: it reads the doc, checks its fleet, and deletes that version
// (a write in between, a move included, makes it read again, unless the caller pinned a version: then 409).
// Humans delete as asked.
export async function deleteInFleet(
  c: Ctx,
  collection: string,
  id: string,
  asked: number | undefined,
  del: (pin: number | undefined) => Promise<"deleted" | "missing">,
  what: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let pin = asked;
    if (fleetScope(c.caller) !== undefined) {
      const cur = await getDoc(c.env.DB, collection, id);
      if (!cur) throw notFound(`No ${what.toLowerCase()} ${id}`);
      requireFleet(c.caller, cur.data, what);
      pin ??= cur.version;
    }
    try {
      if ((await del(pin)) === "missing") throw notFound(`No ${what.toLowerCase()} ${id}`);
      return;
    } catch (e) {
      // Our own pin lost a race: read again (the caller's own pin stands, as for any write).
      if (asked !== undefined || pin === undefined || attempt >= 4 || !(e instanceof HttpError && e.status === 409)) throw e;
    }
  }
}


// The change rows (`changes`, migration 0012) a fleet's orchestrator token sees, `p` binding its fleet (null:
// the default fleet): the fleet's own, and the deployment-wide rows, which log no fleet (people, and meta docs
// not named for a fleet). The default fleet's rows are the ones with no fleet at all, so with one fleet that
// is every row, as before fleets.
export const fleetChangesSql = (p: string) =>
  `(fleet IS ${p} OR (${p} IS NOT NULL AND fleet IS NULL AND collection IN ('users', 'meta')))`;
