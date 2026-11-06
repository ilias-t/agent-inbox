// GET /api/state/delta?since=<cursor>: the part of the caller's /api/state that changed since a cursor, so an
// open page applies a few docs instead of refetching the whole snapshot on every change (docs/api.md, "State
// delta"). It reads the change log after `since` with /api/changes' visibility rules, dedupes the docs it names
// and fetches their current versions, all in one batch (one transaction), so the cursor matches the docs exactly.

import type {
  Doc,
  Item,
  Lease,
  ManagerMeta,
  Orchestrator,
  Schedule,
  StateDelta,
  StateDeltaReset,
} from "../../shared/types.ts";
import { DEFAULT_FLEET } from "../../shared/types.ts";
import { fleetScope, orchestratorScope } from "../auth.ts";
import { fleetChangesSql, metaFleet, metaId } from "../fleets.ts";
import { badRequest, json } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { COLS, toDoc, type DocRow } from "../store.ts";
import { routinesSql } from "../reviews.ts";
import { toPerson } from "../users.ts";
import { fleetScheduleView } from "./schedule.ts";
import { FLEETS_SQL, fleetsMap, PINS_SQL, pinMap, routineState } from "./state.ts";

// At most this many change rows after `since`; further behind, a full /api/state is the cheaper read.
export const DELTA_MAX_CHANGES = 500;

function sinceParam(c: Ctx): number {
  const raw = c.url.searchParams.get("since");
  if (raw === null || !/^\d+$/.test(raw)) throw badRequest("since must be a non-negative integer (a cursor from /api/state)");
  return Number(raw);
}

// Whose view: a human's (every fleet), a fleet's orchestrator token's (the default fleet's, or a named one's;
// docs/api.md "Fleets"), or a manager token's (its own items and doc, in its fleet).
type View = "all" | "fleet" | "named" | "manager";

// The shared head of every statement in the batch, which binds the same six parameters to each (`p` only
// names them all, so every statement takes six): ?1 since, ?2 the orchestrator scope ('' for none), ?3 the
// caller's actor for snoozes and pins ('' for a token), ?4 their email, ?5 now, ?6 a token's fleet (null for
// the default fleet, and for a human, who doesn't use it). They are used directly, not through `p`, so
// `seq > ?1` stays a range scan of the primary key.
//
// `ok` is 1 when the log still holds every change after `since` and there are at most DELTA_MAX_CHANGES of
// them: seq is AUTOINCREMENT and never reused, so cursor - since rows must be there, and fewer means some were
// pruned (by age, so possibly from the middle when an imported doc carried an old updated_at). The CASE keeps
// the count to a short range scan. `ch` is each doc (collection, doc_id) the caller may see changed after
// `since`, deduped; empty unless ok.
function head(view: View): string {
  // As /api/changes (SCOPE_FILTER there), plus two rows /api/changes doesn't show an orchestrator token:
  // meta/schedule, which its /api/state includes, and later changes to an item it had owned (reassigned away,
  // logged under the new orchestrator, or moved to another fleet), so the item leaves its state as it would on
  // a refetch. Only ids it already knew come back that way, as deletes.
  //
  // A fleet's token: as /api/changes (FLEET_FILTER there). A doc an admin moved out of its fleet comes with
  // the rest: the move logs a row under the fleet it left (migration 0012), which the doc fails visibleDocs on.
  // `+fleet` keeps a manager token's rows on changes_orchestrator. Its reassigned-away clause takes only rows in its
  // own fleet: a move out logs under its fleet and orchestrator, and what happens to the doc in another fleet later
  // isn't its business.
  const scope =
    view === "manager"
      ? `AND ((orchestrator = ?2 AND +fleet IS ?6) OR (collection = 'meta' AND doc_id IN ('schedule', 'schedule:' || ?6))
         OR (collection = 'items' AND +fleet IS ?6 AND doc_id IN (SELECT doc_id FROM changes WHERE orchestrator = ?2 AND +fleet IS ?6 AND collection = 'items')))`
      : view === "fleet" || view === "named"
        ? `AND ${fleetChangesSql(view === "named", "?6")}`
        : "";
  return `WITH p AS (SELECT ?1, ?2, ?3, ?4, ?5, ?6),
  head AS (SELECT coalesce(max(seq), 0) AS cursor FROM changes),
  ok AS (
    SELECT CASE WHEN cursor - ?1 BETWEEN 0 AND ${DELTA_MAX_CHANGES}
      THEN (SELECT count(*) FROM changes WHERE seq > ?1) = cursor - ?1 ELSE 0 END AS ok
    FROM head),
  ch AS (
    SELECT DISTINCT collection, doc_id FROM changes NOT INDEXED
    WHERE seq > ?1 AND (SELECT ok FROM ok)
      -- Snoozes and pins reach only their own human (SNOOZE_FILTER in changes.ts).
      AND (collection NOT IN ('snoozes', 'pins') OR actor = ?3)
      ${scope})
  `;
}

// Whether the count of archived items may differ from what it was at `since`, so the delta recounts (an index
// scan of every archived item, the costliest read here) only then. For each item in the window: is it archived
// now, and was it at `since`, by its last change at or before the cursor (a delete: not there, so no), or, when
// it has none, not there yet if its first change in the window created it. An item whose history was pruned
// can't be told, so it counts as a change. An orchestrator token's count also moves when an item is reassigned
// to or from it, so any item change recounts there (its items are few). For a fleet's token "archived" means
// archived in its fleet, by the fleet each change row recorded, so a move in or out counts too.
function archivedMayChange(view: View): string {
  if (view === "manager") return "EXISTS (SELECT 1 FROM ch WHERE collection = 'items')";
  const mine = view === "fleet" || view === "named" ? " AND fleet IS ?6" : "";
  return `EXISTS (SELECT 1 FROM ch WHERE ch.collection = 'items' AND
    coalesce((SELECT status = 'archived'${mine} FROM docs WHERE collection = 'items' AND id = ch.doc_id), 0) IS NOT coalesce(
      (SELECT CASE WHEN op = 'delete' THEN 0 ELSE coalesce(status = 'archived'${mine}, 0) END FROM changes
        WHERE collection = 'items' AND doc_id = ch.doc_id AND seq <= ?1 ORDER BY seq DESC LIMIT 1),
      (SELECT CASE WHEN op = 'create' THEN 0 END FROM changes
        WHERE collection = 'items' AND doc_id = ch.doc_id AND seq > ?1 ORDER BY seq LIMIT 1)))`;
}

// The docs /api/state would show the caller, of `d`.
// Meta docs come from their own statement (META_SQL).
function visibleDocs(view: View): string {
  if (view === "manager") {
    return `(d.collection = 'items' AND d.orchestrator = ?2 AND d.fleet IS ?6)
       OR (d.collection = 'orchestrators' AND d.id = ?2 AND d.fleet IS ?6)`;
  }
  return view === "all" ? "d.collection IN ('items', 'orchestrators')" : "d.collection IN ('items', 'orchestrators') AND d.fleet IS ?6";
}

// The caller's fleet's manager, lease and schedule docs (?6: null for a person, the default fleet), and the
// deployment's schedule, which a named fleet without hours of its own falls back on. Two to four primary-key reads.
const META_SQL = `SELECT ${COLS} FROM docs WHERE collection = 'meta'
  AND id IN (coalesce('manager:' || ?6, 'manager'), coalesce('lease:' || ?6, 'lease'), 'schedule', 'schedule:' || ?6)`;

// A change to any part of a fleet's entry in /api/state `fleets`: its registry doc, or a meta doc it reads (the bare
// ids are the default fleet's, and meta/schedule is also the hours every fleet without its own inherits).
const FLEET_PART = `(collection = 'fleets' OR (collection = 'meta' AND (doc_id IN ('manager', 'lease', 'schedule')
  OR doc_id GLOB 'manager:*' OR doc_id GLOB 'lease:*' OR doc_id GLOB 'schedule:*')))`;

// The fleets whose entry a change to (collection, id) touches: "*" for every fleet.
function fleetTouched(collection: string, id: string): string | undefined {
  if (collection === "fleets") return id;
  if (collection !== "meta") return undefined;
  if (id === "schedule") return "*";
  if (id === "manager" || id === "lease") return DEFAULT_FLEET;
  const named = metaFleet(id);
  return named ? (named.fleet ?? DEFAULT_FLEET) : undefined;
}

const D_COLS = COLS.split(", ").map((col) => `d.${col}`).join(", ");

async function delta(c: Ctx): Promise<Response> {
  const since = sinceParam(c);
  const db = c.env.DB;
  const scope = orchestratorScope(c.caller);
  const fleet = fleetScope(c.caller);
  const view: View = scope !== null ? "manager" : fleet === undefined ? "all" : fleet === null ? "fleet" : "named";
  const p = c.caller.principal;
  const email = p.kind === "human" ? p.email.toLowerCase() : "";
  const binds = [since, scope ?? "", email ? `human:${email}` : "", email, c.now, fleet ?? null];
  const pre = head(view);
  const stmt = (sql: string) => db.prepare(pre + sql).bind(...binds);
  // `+fleet` beside orchestrator keeps a manager token's count on docs_orchestrator (its few items).
  const own = view === "manager" ? " AND orchestrator = ?2 AND +fleet IS ?6" : view === "all" ? "" : " AND fleet IS ?6";

  const [top, keys, docs, users, snoozes, pins, routines, meta, fleetRows] = await db.batch<any>([
    stmt(`SELECT head.cursor, ok.ok,
      CASE WHEN ${archivedMayChange(view)}
        THEN (SELECT count(*) FROM docs WHERE collection = 'items' AND status = 'archived'${own}) END AS archived
      FROM head, ok`),
    stmt("SELECT collection, doc_id FROM ch ORDER BY collection, doc_id"),
    // CROSS JOIN keeps ch outermost: a primary-key lookup per changed doc, never a scan of docs.
    stmt(`SELECT ${D_COLS} FROM ch CROSS JOIN docs AS d ON d.collection = ch.collection AND d.id = ch.doc_id
      WHERE ${visibleDocs(view)}`),
    // Orchestrator tokens see no people (and no users rows reach their ch).
    stmt(`SELECT email, name, ntfy_topic FROM users WHERE EXISTS (SELECT 1 FROM ch WHERE collection = 'users') ORDER BY email`),
    // The caller's snoozes still to come, as /api/state lists them.
    stmt(`SELECT item_id, until FROM snoozes WHERE email = ?4 AND until > ?5
      AND EXISTS (SELECT 1 FROM ch WHERE collection = 'snoozes') ORDER BY item_id`),
    // The caller's pins, as /api/state lists them.
    stmt(`SELECT * FROM (${PINS_SQL.replace("?1", "?4")}) WHERE EXISTS (SELECT 1 FROM ch WHERE collection = 'pins')`),
    // Review routines, as /api/state lists them, when one changed (its head's change row is in ch).
    stmt(`SELECT * FROM (${routinesSql("?2", view === "all" ? undefined : "?6")}) WHERE EXISTS (SELECT 1 FROM ch WHERE collection = 'reviews') ORDER BY id`),
    // The caller's meta docs, when one of them is in ch.
    stmt(`${META_SQL} AND EXISTS (SELECT 1 FROM ch WHERE collection = 'meta')`),
    // People's `fleets` map, when part of it is in ch.
    stmt(`SELECT * FROM (${FLEETS_SQL}) WHERE ${view === "all" ? `EXISTS (SELECT 1 FROM ch WHERE ${FLEET_PART})` : "0"}`),
  ]);
  // The ids this caller's manager, lease and schedule have (a person's: the default fleet's).
  const mine = fleet ?? null;
  const ids = { manager: metaId("manager", mine), lease: metaId("lease", mine), schedule: metaId("schedule", mine) };
  const metaRow = (id: string) => (meta.results as DocRow[]).find((r) => r.id === id) ?? null;
  const { cursor, ok, archived } = top.results[0] as { cursor: number; ok: number; archived: number | null };
  if (!ok) return json({ reset: true } satisfies StateDeltaReset);

  const byKey = new Map((docs.results as DocRow[]).map((r) => [`${r.collection}\u0000${r.id}`, r]));
  const found = (collection: string, id: string) => byKey.get(`${collection}\u0000${id}`) ?? null;
  const body: StateDelta = {
    cursor,
    items: [],
    orchestrators: [],
    deleted: [],
    qa_changed: [],
    me: p,
  };
  if (archived !== null) body.archived_total = archived;
  const qa = new Set<string>();
  const reviews: string[] = [];
  const fleets = new Set<string>();
  for (const { collection, doc_id: id } of keys.results as { collection: string; doc_id: string }[]) {
    const touched = view === "all" ? fleetTouched(collection, id) : undefined;
    if (touched !== undefined) fleets.add(touched);
    if (collection === "items" || collection === "orchestrators") {
      const row = found(collection, id);
      if (!row) body.deleted.push({ collection, id });
      else if (collection === "items") body.items.push(toDoc<Item>(row));
      else body.orchestrators.push(toDoc<Orchestrator>(row));
    } else if (collection.startsWith("items/") && collection.endsWith("/qa")) {
      qa.add(collection.slice("items/".length, -"/qa".length));
    } else if (collection === "meta") {
      // Tokens scoped to an orchestrator get manager and lease as null in /api/state, and no rows for them here.
      const row = metaRow(id);
      if (view !== "manager" && id === ids.manager) body.manager = row && toDoc<ManagerMeta>(row);
      else if (view !== "manager" && id === ids.lease) body.lease = row && toDoc<Lease>(row);
      else if (id === "schedule" || id === ids.schedule) {
        const doc = (i: string) => {
          const r = metaRow(i);
          return r ? toDoc<Schedule>(r) : null;
        };
        body.schedule = fleetScheduleView(mine, mine === null ? null : doc(ids.schedule), doc("schedule"));
      }
    } else if (collection === "users") {
      body.people = view === "manager" ? [] : users.results.map(toPerson);
    } else if (collection === "reviews") {
      reviews.push(id);
    } else if (collection === "snoozes") {
      body.snoozes = Object.fromEntries(snoozes.results.map((r: { item_id: string; until: string }) => [r.item_id, r.until]));
    } else if (collection === "pins") {
      body.pins = pinMap(pins.results);
    }
  }
  body.items.sort(byCreated);
  body.orchestrators.sort(byCreated);
  body.qa_changed = [...qa].sort();
  if (reviews.length) {
    body.reviews_changed = reviews; // keys come sorted
    body.routines = routines.results.map(routineState);
  }
  if (fleets.size) {
    const map = fleetsMap(fleetRows.results as DocRow[], new Date(c.now), fleets.has("*") ? undefined : fleets);
    if (Object.keys(map).length) body.fleets = map;
  }
  return json(body);
}

const byCreated = (a: Doc<unknown>, b: Doc<unknown>) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export const deltaRoutes: Route[] = [["GET", "/state/delta", delta]];
