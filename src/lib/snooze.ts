// Snooze: the human hides an open item from the Inbox until a time (POST /api/items/:id/snooze).
// The presets are wall-clock times in the schedule's zone, so "Tomorrow 9 am" is 9 am where the work happens.
import { wallClock, zonedToUtc } from "../../shared/schedule.ts";

export interface SnoozePreset { id: "hour" | "tonight" | "tomorrow" | "monday"; label: string; until: string }

const TONIGHT = 18 * 60, MORNING = 9 * 60;

function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
// The schedule's zone (meta/schedule), else this browser's.
export function snoozeZone(scheduleTz: string | undefined | null): string {
  return scheduleTz && validZone(scheduleTz) ? scheduleTz : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// 1 hour; 6 pm today (tomorrow once it's past); 9 am tomorrow; 9 am on the next Monday after today
// (dropped on a Sunday, where it is tomorrow 9 am). DST-safe: each is a wall-clock time converted on its own day.
export function snoozePresets(now: number, tz: string): SnoozePreset[] {
  const w = wallClock(tz, now), iso = (t: number) => new Date(t).toISOString();
  const local = (days: number, minute: number) => zonedToUtc(tz, w.y, w.mo, w.d + days, minute);
  const tonightToday = local(0, TONIGHT) > now;
  const tomorrow = local(1, MORNING);
  const monday = local(((1 - w.wd + 7) % 7) || 7, MORNING);
  const out: SnoozePreset[] = [
    { id: "hour", label: "1 hour", until: iso(now + 3600_000) },
    tonightToday ? { id: "tonight", label: "Tonight (6 pm)", until: iso(local(0, TONIGHT)) } : { id: "tonight", label: "Tomorrow 6 pm", until: iso(local(1, TONIGHT)) },
    { id: "tomorrow", label: "Tomorrow 9 am", until: iso(tomorrow) },
  ];
  if (monday !== tomorrow) out.push({ id: "monday", label: "Monday 9 am", until: iso(monday) });
  return out;
}
