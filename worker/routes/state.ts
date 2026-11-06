// /api/me and /api/state: everything the UI needs on boot, in one snapshot.

import type { Item, Lease, ManagerMeta, Orchestrator, Pins, RoutineState, Schedule, StateResponse } from "../../shared/types.ts";
import { fleetScope, orchestratorScope } from "../auth.ts";
import { badRequest, json } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { COLS, toDoc, type DocRow } from "../store.ts";
import { routinesSql } from "../reviews.ts";
import { toPerson, type UserRow } from "../users.ts";
import { scheduleView } from "./schedule.ts";

async function me(c: Ctx): Promise<Response> {
  return json(c.caller.principal);
}

export const ARCHIVED_MAX = 1000;

// One human's pins as /api/state and the delta send them: "<kind>:<ref>" → pinned at. ?1 is their email.
export const PINS_SQL = "SELECT kind || ':' || ref AS key, created_at FROM pins WHERE email = ?1 ORDER BY kind, ref";
export const pinMap = (rows: { key: string; created_at: string }[]): Pins => Object.fromEntries(rows.map((r) => [r.key, r.created_at]));

// A row of routinesSql, as the wire type (D1 rows carry only these columns, but a fresh object keeps it exact).
export const routineState = (r: RoutineState): RoutineState => ({ id: r.id, version: r.version, last_run_at: r.last_run_at, result: r.result });

// `?archived=n`: every open/decided/processing item, but only the n most
// recently updated archived ones (ties by id), so the snapshot the UI refetches
// on every change stops growing with history. Without it, every item, as
// before (the CLI's `state` and the manager read that).
function archivedLimit(c: Ctx): number | null {
  const raw = c.url.searchParams.get("archived");
  if (raw === null) return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n > ARCHIVED_MAX) throw badRequest(`archived must be an integer from 0 to ${ARCHIVED_MAX}`);
  return n;
}

async function state(c: Ctx): Promise<Response> {
  const db = c.env.DB;
  const scope = orchestratorScope(c.caller);
  // A token sees its own fleet (docs/api.md "Fleets"); a manager token, its own items and doc in it.
  const fleet = fleetScope(c.caller);
  const limit = archivedLimit(c);
  const sel = (where: string, ...binds: unknown[]) =>
    db.prepare(`SELECT ${COLS} FROM docs WHERE ${where} ORDER BY created_at, id`).bind(...binds);
  // `+fleet` beside orchestrator keeps a manager token's reads on docs_orchestrator (its few items).
  const inFleet = fleet === undefined ? "" : scope !== null ? " AND +fleet IS ?" : " AND fleet IS ?";
  const fleetBinds = fleet === undefined ? [] : [fleet];
  const own = (scope === null ? "" : " AND orchestrator = ?") + inFleet;
  const ownBinds = [...(scope === null ? [] : [scope]), ...fleetBinds];
  const itemQueries =
    limit === null
      ? [sel("collection = 'items'" + own, ...ownBinds)]
      : [
          // Index seeks, not `status IS NOT 'archived'` (a scan of every item). A status-less
          // item (only a raw import makes one) reads as open in the UI, so it comes too.
          sel("collection = 'items' AND status IN ('open', 'decided', 'processing')" + own, ...ownBinds),
          sel("collection = 'items' AND status IS NULL" + own, ...ownBinds),
          db
            .prepare(`SELECT ${COLS} FROM docs WHERE collection = 'items' AND status = 'archived'${own} ORDER BY updated_at DESC, id DESC LIMIT ?`)
            .bind(...ownBinds, limit),
        ];
  // One batch is one transaction, so the cursor matches the docs exactly.
  const p = c.caller.principal;
  const [cursor, archivedCount, orchs, meta, users, snoozes, pins, routines, ...itemRows] = await db.batch<
    DocRow & UserRow & RoutineState & { seq: number; n: number; item_id: string; until: string; key: string; created_at: string }
  >([
    db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM changes"),
    db.prepare(`SELECT count(*) AS n FROM docs WHERE collection = 'items' AND status = 'archived'${own}`).bind(...ownBinds),
    scope === null
      ? sel("collection = 'orchestrators'" + inFleet, ...fleetBinds)
      : sel("collection = 'orchestrators' AND id = ?" + inFleet, scope, ...fleetBinds),
    sel("collection = 'meta' AND id IN ('manager', 'lease', 'schedule')"),
    // Orchestrator tokens see no people.
    db.prepare("SELECT email, name, ntfy_topic FROM users WHERE ?1 ORDER BY email").bind(scope === null ? 1 : 0),
    // The caller's own snoozes still to come (migration 0007); tokens have none.
    db
      .prepare("SELECT item_id, until FROM snoozes WHERE email = ?1 AND until > ?2 ORDER BY item_id")
      .bind(p.kind === "human" ? p.email.toLowerCase() : "", c.now),
    // The caller's own pins (migration 0010); tokens have none.
    db.prepare(PINS_SQL).bind(p.kind === "human" ? p.email.toLowerCase() : ""),
    // Review routines (docs/reviews.md); an orchestrator token's own only, a token's fleet's only.
    fleet === undefined ? db.prepare(routinesSql("?1")).bind(scope ?? "") : db.prepare(routinesSql("?1", "?2")).bind(scope ?? "", fleet),
    ...itemQueries,
  ]);
  const itemDocs = itemRows.flatMap((r) => r.results);
  const archivedTotal = archivedCount.results[0].n;
  // The archived page is the last item query.
  const archivedShown = limit === null ? archivedTotal : itemRows[itemRows.length - 1].results.length;
  const metaDoc = <T,>(id: string) => {
    const row = meta.results.find((r) => r.id === id);
    return row ? toDoc<T>(row) : null;
  };
  const body: StateResponse = {
    items: itemDocs.map((r) => toDoc<Item>(r)),
    orchestrators: orchs.results.map((r) => toDoc<Orchestrator>(r)),
    // Orchestrator tokens can't read meta docs, so they get nulls here too.
    manager: scope === null ? metaDoc<ManagerMeta>("manager") : null,
    lease: scope === null ? metaDoc<Lease>("lease") : null,
    schedule: scheduleView(metaDoc<Schedule>("schedule")),
    cursor: cursor.results[0].seq,
    me: c.caller.principal,
    people: users.results.map(toPerson),
    snoozes: Object.fromEntries(snoozes.results.map((r) => [r.item_id, r.until])),
    pins: pinMap(pins.results),
    archived_total: archivedTotal,
    archived_more: archivedShown < archivedTotal,
    routines: routines.results.map(routineState),
  };
  return json(body);
}

export const stateRoutes: Route[] = [
  ["GET", "/me", me],
  ["GET", "/state", state],
];
