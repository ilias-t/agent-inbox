// meta/schedule: the work-hours source of truth, with the computed view.

import { computeSchedule, validateSchedule } from "../../shared/schedule.ts";
import { DEFAULT_SCHEDULE, type Doc, type Schedule, type ScheduleView } from "../../shared/types.ts";
import { requireFullAdmin } from "../auth.ts";
import { badRequest, ifVersion, json } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { getDoc, mutate } from "../store.ts";

// Defaults while the doc is missing, and if an imported doc doesn't validate
// (flagged, so a read-merge-write client doesn't overwrite it with the defaults).
export function scheduleView(doc: Doc<Schedule> | null, now = new Date()): ScheduleView {
  const v = doc ? validateSchedule(doc.data) : null;
  const schedule = v?.ok ? v.schedule : DEFAULT_SCHEDULE;
  const view: ScheduleView = { schedule, version: doc?.version ?? null, computed: computeSchedule(schedule, now) };
  if (v && !v.ok) view.stored_invalid = true;
  return view;
}

// Validated schedule data or a 400.
export function checkSchedule(input: unknown): Schedule {
  const v = validateSchedule(input);
  if (!v.ok) throw badRequest(v.message);
  return v.schedule;
}

async function get(c: Ctx): Promise<Response> {
  return json(scheduleView(await getDoc<Schedule>(c.env.DB, "meta", "schedule")));
}

async function put(c: Ctx): Promise<Response> {
  requireFullAdmin(c.caller);
  const body = await c.body();
  const schedule = checkSchedule(body.schedule);
  const { doc } = await mutate<Schedule>(
    c.env.DB,
    "meta",
    "schedule",
    { actor: c.caller.actor, now: c.now, ifVersion: ifVersion(body.if_version) },
    () => schedule,
  );
  return json(scheduleView(doc));
}

export const scheduleRoutes: Route[] = [
  ["GET", "/schedule", get],
  ["PUT", "/schedule", put],
];
