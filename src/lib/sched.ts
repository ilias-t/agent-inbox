import type { ScheduleView } from "../../shared/types.ts";
import { slotTime } from "./time.ts";

// Header copy from the schedule view (meta/schedule + computeSchedule). The manager's cron only runs inside
// work hours; outside them the header says when the next pickup is and the "down" warnings are suppressed.

export function pickupMin(v: ScheduleView | null): number { const n = Number(v?.schedule.pickup_interval_min); return n > 0 ? n : 10; }
export function sweepMin(v: ScheduleView | null): number { const n = Number(v?.schedule.sweep_interval_min); return n > 0 ? n : 30; }
export function offHours(v: ScheduleView | null): boolean { return !!v && !v.computed.in_hours; }

function nextOffHours(v: ScheduleView, now: number): string {
  const at = v.computed.next_pickup_at || v.computed.next_window_start;
  return at ? slotTime(at, v.schedule.timezone, now, true, "today") : "";
}

// {text, off}: "Decisions picked up every ~10 min · full sweep every ~30 min · 10:00–18:00 ET, Mon–Fri · next pickup 14:23",
// off = " · Off hours (next pickup Thu 10:03 ET)" outside the window (rendered in .off).
export function cadence(v: ScheduleView | null, now = Date.now()): { text: string; off: string } {
  let text = "Decisions picked up every ~" + pickupMin(v) + " min · full sweep every ~" + sweepMin(v) + " min";
  if (!v) return { text, off: "" };
  if (v.computed.label) text += " · " + v.computed.label;
  if (!v.computed.in_hours) {
    const next = nextOffHours(v, now);
    return { text, off: " · Off hours" + (next ? " (next pickup " + next + ")" : "") };
  }
  if (v.computed.next_pickup_at) text += " · next pickup " + slotTime(v.computed.next_pickup_at, v.schedule.timezone, now);
  return { text, off: "" };
}

// "picked up within ~10 min", or "next pickup Thu 10:03 ET" off hours.
export function pickupPhrase(v: ScheduleView | null, now = Date.now()): string {
  if (v && !v.computed.in_hours) { const next = nextOffHours(v, now); if (next) return "next pickup " + next; }
  return "picked up within ~" + pickupMin(v) + " min";
}
