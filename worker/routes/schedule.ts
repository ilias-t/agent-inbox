// meta/schedule: the work-hours source of truth, with the computed view. A
// named fleet may keep its own hours in meta/schedule:<fleet> and falls back on
// meta/schedule while it has none (docs/api.md "Fleets").

import { computeSchedule, validateSchedule } from "../../shared/schedule.ts";
import { DEFAULT_SCHEDULE, type Doc, type Schedule, type ScheduleView } from "../../shared/types.ts";
import { requireFullAdmin } from "../auth.ts";
import { metaId, registeredTarget, targetFleet } from "../fleets.ts";
import { badRequest, conflict, ifVersion, json } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { COLS, deleteDoc, mutate, toDoc, type DocRow } from "../store.ts";

// Defaults while the doc is missing, and if an imported doc doesn't validate
// (flagged, so a read-merge-write client doesn't overwrite it with the defaults).
export function scheduleView(doc: Doc<Schedule> | null, now = new Date()): ScheduleView {
  const v = doc ? validateSchedule(doc.data) : null;
  const schedule = v?.ok ? v.schedule : DEFAULT_SCHEDULE;
  const view: ScheduleView = { schedule, version: doc?.version ?? null, computed: computeSchedule(schedule, now) };
  if (v && !v.ok) view.stored_invalid = true;
  return view;
}

// A fleet's schedule view from its own doc and the deployment's (either may be null): its own when it has one;
// else the deployment's hours, with `inherited: true`, the version of the fleet's own doc (null: none yet), so a
// read-merge-write pins on the doc it writes, and `inherited_version`, the deployment's doc's, so a client sees
// those hours change. A deployment schedule that doesn't validate isn't flagged here: the fleet has nothing
// stored that a write would replace. The default fleet's own doc is the deployment's.
// A fleet's own doc that doesn't validate gives the built-in defaults (flagged stored_invalid), not the
// deployment's hours: what it stored is its choice, and a client must see it is broken rather than fixed for it.
export function fleetScheduleView(fleet: string | null, own: Doc<Schedule> | null, shared: Doc<Schedule> | null, now = new Date()): ScheduleView {
  if (fleet === null) return scheduleView(shared, now);
  if (own) return scheduleView(own, now);
  const { stored_invalid: _, ...view } = scheduleView(shared, now);
  return { ...view, version: null, inherited: true, inherited_version: shared?.version ?? null };
}

// Both docs a fleet's schedule may come from, in one read.
export async function fleetSchedule(db: D1Database, fleet: string | null): Promise<ScheduleView> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM docs WHERE collection = 'meta' AND id IN ('schedule', ?)`)
    .bind(metaId("schedule", fleet))
    .all<DocRow>();
  const doc = (id: string) => {
    const row = results.find((r) => r.id === id);
    return row ? toDoc<Schedule>(row) : null;
  };
  return fleetScheduleView(fleet, fleet === null ? null : doc(metaId("schedule", fleet)), doc("schedule"));
}

// The fleet a schedule call is for: a token's own, or the one a person names (?fleet= or the body's fleet; the
// default fleet without one).
const scheduleFleet = (c: Ctx, body?: Record<string, unknown>) => registeredTarget(c, targetFleet(c, body));

// Validated schedule data or a 400.
export function checkSchedule(input: unknown): Schedule {
  const v = validateSchedule(input);
  if (!v.ok) throw badRequest(v.message);
  return v.schedule;
}

async function get(c: Ctx): Promise<Response> {
  return json(await fleetSchedule(c.env.DB, await scheduleFleet(c)));
}

async function put(c: Ctx): Promise<Response> {
  requireFullAdmin(c.caller);
  const body = await c.body();
  const fleet = await scheduleFleet(c, body); // before the schedule: another fleet's is 403 whatever it says
  const schedule = checkSchedule(body.schedule);
  const { doc } = await mutate<Schedule>(
    c.env.DB,
    "meta",
    metaId("schedule", fleet),
    { actor: c.caller.actor, now: c.now, ifVersion: ifVersion(body.if_version) },
    () => schedule,
  );
  return json(scheduleView(doc));
}

// A named fleet goes back to the deployment's hours: its own schedule doc is deleted (pinned with ?if_version=).
// The default fleet's schedule is the deployment's, which stays.
async function del(c: Ctx): Promise<Response> {
  requireFullAdmin(c.caller);
  const fleet = await scheduleFleet(c, await c.body());
  if (fleet === null) throw badRequest("The default fleet's schedule is the deployment's: replace it with PUT, it can't be removed");
  const pin = ifVersion(c.url.searchParams.get("if_version"));
  const r = await deleteDoc(c.env.DB, "meta", metaId("schedule", fleet), { version: pin });
  // Nothing to drop is fine, unless the caller pinned a version it read: then that doc is gone already.
  if (r === "missing" && pin !== undefined) throw conflict("conflict", `No meta/${metaId("schedule", fleet)} at version ${pin}: it was dropped already`, null);
  return json(await fleetSchedule(c.env.DB, fleet));
}

export const scheduleRoutes: Route[] = [
  ["GET", "/schedule", get],
  ["PUT", "/schedule", put],
  ["DELETE", "/schedule", del],
];
