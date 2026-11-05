import { describe, expect, it } from "vitest";
import type { Lease, ManagerMeta, ScheduleView } from "../../shared/types.ts";
import { digestIsNew, offlineText, tickStatus } from "../../src/lib/status.ts";

const NOW = Date.parse("2026-10-07T18:20:00Z"); // Wed 14:20 ET
const iso = (minFromNow: number) => new Date(NOW + minFromNow * 60000).toISOString();
const view = (over: Partial<ScheduleView["computed"]> = {}): ScheduleView => ({
  schedule: { work_hours: "10:00-18:00 Mon-Fri", timezone: "America/New_York", pickup_interval_min: 10, sweep_interval_min: 30 },
  version: 1,
  computed: {
    now: new Date(NOW).toISOString(), in_hours: true, next_pickup_at: "2026-10-07T18:23:00Z", next_window_start: null,
    label: "10:00–18:00 ET, Mon–Fri", utc_offset_min: -240, cron_utc: ["3-59/10 14-21 * * 1-5"], cron_exact: true, ...over,
  },
});
const off = () => view({ in_hours: false, next_pickup_at: "2026-10-08T14:03:00Z", next_window_start: "2026-10-08T14:00:00Z" });
const lease = (expiresMin: number): Lease => ({ holder_session_id: "s", acquired_at: iso(-60), heartbeat_at: iso(-5), expires_at: iso(expiresMin) });

describe("tickStatus: the inbox header's one status line", () => {
  it("before the orchestrator has written anything", () => {
    expect(tickStatus(null, null, view(), NOW)).toEqual({ kind: "unknown", text: "Orchestrator hasn't checked in yet" });
  });

  it("in hours: when the next pickup runs", () => {
    const m: ManagerMeta = { last_tick: iso(-4), next_tick: iso(6) };
    expect(tickStatus(m, lease(20), view(), NOW)).toEqual({ kind: "ok", text: "Next pickup 14:23" });
  });

  it("an overdue tick says how late it is, not 'next 5m ago'", () => {
    const m: ManagerMeta = { last_tick: iso(-15), next_tick: iso(-5) };
    expect(tickStatus(m, lease(20), view(), NOW)).toEqual({ kind: "warn", text: "Tick overdue 5m" });
  });

  it("a tick less than a minute late isn't overdue yet", () => {
    expect(tickStatus({ next_tick: iso(-0.5) }, null, view(), NOW).kind).toBe("ok");
  });

  it("an expired lease in hours warns first", () => {
    const m: ManagerMeta = { last_tick: iso(-15), next_tick: iso(-5) };
    expect(tickStatus(m, lease(-2), view(), NOW)).toEqual({ kind: "warn", text: "Orchestrator may be down" });
  });

  it("offline, the status pauses: an expired lease or an overdue tick is this page's stale data, not the orchestrator", () => {
    const paused = { kind: "paused", text: "Orchestrator status paused" };
    const m: ManagerMeta = { last_tick: iso(-15), next_tick: iso(-5) };
    expect(tickStatus(m, lease(-2), view(), NOW, { offline: true })).toEqual(paused);
    expect(tickStatus(m, lease(20), view(), NOW, { offline: true })).toEqual(paused);
    // Nor does it name a next pickup it can't confirm, or a tick request it can't see run.
    expect(tickStatus({ next_tick: iso(6) }, lease(20), view(), NOW, { offline: true })).toEqual(paused);
    expect(tickStatus({ next_tick: iso(6), tick_requested_at: iso(-1) }, lease(20), view(), NOW, { offline: true })).toEqual(paused);
    expect(tickStatus(null, null, null, NOW, { offline: true })).toEqual(paused);
  });
  it("back online it reads as before", () => {
    expect(tickStatus({ next_tick: iso(6) }, lease(20), view(), NOW, { offline: false })).toEqual({ kind: "ok", text: "Next pickup 14:23" });
  });

  it("off hours: a stale next tick and an expired lease are expected, so it names the next pickup", () => {
    const m: ManagerMeta = { last_tick: iso(-600), next_tick: iso(-540) };
    expect(tickStatus(m, lease(-500), off(), NOW)).toEqual({ kind: "idle", text: "Off hours · next pickup Thu 10:03 ET" });
  });

  it("a requested tick that hasn't run yet", () => {
    const s = tickStatus({ last_tick: iso(-4), next_tick: iso(6), tick_requested_at: iso(-1) }, lease(20), view(), NOW);
    expect(s.kind).toBe("pending");
    expect(s.text).toMatch(/^Tick requested /);
  });

  it("a request older than the last tick is done", () => {
    expect(tickStatus({ last_tick: iso(-1), next_tick: iso(9), tick_requested_at: iso(-3) }, lease(20), view(), NOW).kind).toBe("ok");
  });

  it("without a schedule: the orchestrator's own next tick, then its last one", () => {
    expect(tickStatus({ last_tick: iso(-4), next_tick: iso(6) }, null, null, NOW)).toEqual({ kind: "ok", text: "Next tick in 6m" });
    expect(tickStatus({ last_tick: iso(-4) }, null, null, NOW)).toEqual({ kind: "ok", text: "Last tick 4m ago" });
  });
});

describe("digestIsNew", () => {
  it("is new when it differs from the one last shown", () => {
    expect(digestIsNew("- O3 waits", null)).toBe(true);
    expect(digestIsNew("- O3 waits", "- O2 blocked")).toBe(true);
  });
  it("isn't when it's the one last shown, or empty", () => {
    expect(digestIsNew("- O3 waits", "- O3 waits")).toBe(false);
    expect(digestIsNew("", null)).toBe(false);
    expect(digestIsNew(undefined, null)).toBe(false);
  });
});

describe("offlineText: the offline banner", () => {
  const tz = "America/New_York";
  it("says when the inbox shown is from, in the schedule's zone", () => {
    expect(offlineText(Date.parse("2026-10-07T18:12:00Z"), tz, NOW)).toBe("Offline. Showing the inbox from 14:12.");
  });
  it("names the day when it's from another one", () => {
    expect(offlineText(Date.parse("2026-10-06T21:05:00Z"), tz, NOW)).toBe("Offline. Showing the inbox from Tue 17:05.");
  });
  it("dates it once it's 6 days old or more, where a weekday would be ambiguous", () => {
    expect(offlineText(Date.parse("2026-10-02T18:12:00Z"), tz, NOW)).toBe("Offline. Showing the inbox from Fri 14:12."); // 5 days
    expect(offlineText(Date.parse("2026-09-28T18:12:00Z"), tz, NOW)).toBe("Offline. Showing the inbox from Mon 28 Sep 14:12.");
    expect(offlineText(Date.parse("2026-10-01T18:12:00Z"), tz, NOW)).toBe("Offline. Showing the inbox from Thu 1 Oct 14:12.");
  });
  it("before anything loaded", () => {
    expect(offlineText(null, tz, NOW)).toBe("Offline. Updates resume when you reconnect.");
  });
});
