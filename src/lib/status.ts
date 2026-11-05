import type { Lease, ManagerMeta, ScheduleView } from "../../shared/types.ts";
import { offHours, pickupPhrase } from "./sched.ts";
import { clockTime, dayKey, dayLabel, relTime, slotTime, toMs, zoneClock } from "./time.ts";

// The inbox header's one status line: the single most useful thing about the manager right now.
// Warnings first (manager down, tick overdue), then a pending tick request, then when the next pickup is.
// kind drives the dot: ok (green), warn (amber), pending (accent), idle (off hours), paused (offline), unknown (grey).
export type TickKind = "ok" | "warn" | "pending" | "idle" | "paused" | "unknown";
export interface TickStatus { kind: TickKind; text: string }

export function tickPending(m: ManagerMeta | null): boolean {
  if (!m || !m.tick_requested_at) return false;
  const req = toMs(m.tick_requested_at), last = toMs(m.last_tick);
  return !isNaN(req) && (isNaN(last) || last <= req);
}

// opts.offline: the page can't reach the server (the offline banner shows, with how old the inbox shown is), so its
// lease and next tick are stale copies that say nothing about the manager now: the status pauses.
export function tickStatus(
  m: ManagerMeta | null, lease: Lease | null, v: ScheduleView | null, now = Date.now(), opts: { offline?: boolean } = {},
): TickStatus {
  if (opts.offline) return { kind: "paused", text: "Orchestrator status paused" };
  if (!m) return { kind: "unknown", text: "Orchestrator hasn't checked in yet" };
  const off = offHours(v);
  // Outside work hours no pickups run, so an expired lease or a stale next tick is expected.
  if (!off) {
    const exp = toMs(lease && lease.expires_at);
    if (!isNaN(exp) && now > exp) return { kind: "warn", text: "Orchestrator may be down" };
    const next = toMs(m.next_tick);
    if (!isNaN(next) && next < now - 60000) return { kind: "warn", text: "Tick overdue " + relTime(m.next_tick, true, now) };
  }
  if (tickPending(m)) return { kind: "pending", text: "Tick requested " + clockTime(m.tick_requested_at) };
  if (off && v) return { kind: "idle", text: "Off hours · " + pickupPhrase(v, now) };
  if (v && v.computed.next_pickup_at) return { kind: "ok", text: "Next pickup " + slotTime(v.computed.next_pickup_at, v.schedule.timezone, now) };
  if (!isNaN(toMs(m.next_tick))) return { kind: "ok", text: "Next tick " + relTime(m.next_tick, false, now) };
  if (!isNaN(toMs(m.last_tick))) return { kind: "ok", text: "Last tick " + relTime(m.last_tick, false, now) };
  return { kind: "unknown", text: "Orchestrator hasn't checked in yet" };
}

// The manager digest opens by itself only when it changed since this viewer last saw it.
export function digestIsNew(digest: string | null | undefined, lastSeen: string | null): boolean {
  return !!digest && digest !== lastSeen;
}

// The offline banner: what the page shows meanwhile. `at`: when the inbox on screen was last confirmed by the server
// (the moment the connection went, or the saved copy's time), null before anything loaded. Today's time is "14:12",
// another day's "Thu 14:12", in the schedule's zone.
// From 6 days back a weekday alone would be ambiguous: "Mon 5 Oct 14:12".
export function offlineText(at: number | null, tz: string, now = Date.now()): string {
  if (at === null || isNaN(at)) return "Offline. Updates resume when you reconnect.";
  const when = now - at >= 6 * 86400000 ? dayLabel(dayKey(at, tz), tz, now) + " " + zoneClock(at, tz) : slotTime(at, tz, now);
  return "Offline. Showing the inbox from " + when + ".";
}
