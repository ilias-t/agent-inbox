import { describe, expect, it } from "vitest";
import type { ScheduleView } from "../../shared/types.ts";
import { cadence, offHours, pickupPhrase } from "../../src/lib/sched.ts";

const NOW = Date.parse("2026-10-07T18:20:00Z"); // Wed 14:20 ET
const view = (over: Partial<ScheduleView["computed"]>): ScheduleView => ({
  schedule: { work_hours: "10:00-18:00 Mon-Fri", timezone: "America/New_York", pickup_interval_min: 10, sweep_interval_min: 30 },
  version: 1,
  computed: {
    now: new Date(NOW).toISOString(), in_hours: true, next_pickup_at: "2026-10-07T18:23:00Z", next_window_start: null,
    label: "10:00–18:00 ET, Mon–Fri", utc_offset_min: -240, cron_utc: ["3-59/10 14-21 * * 1-5"], cron_exact: true, ...over,
  },
});

describe("cadence line", () => {
  it("in hours: intervals, window and next pickup", () => {
    expect(cadence(view({}), NOW)).toEqual({ text: "Decisions picked up every ~10 min · full sweep every ~30 min · 10:00–18:00 ET, Mon–Fri · next pickup 14:23", off: "" });
    expect(offHours(view({}))).toBe(false);
  });
  it("off hours: says when the next pickup is", () => {
    const v = view({ in_hours: false, next_pickup_at: "2026-10-08T14:03:00Z", next_window_start: "2026-10-08T14:00:00Z" });
    expect(cadence(v, NOW).off).toBe(" · Off hours (next pickup Thu 10:03 ET)");
    expect(offHours(v)).toBe(true);
  });
  it("defaults before the schedule loads", () => {
    expect(cadence(null).text).toBe("Decisions picked up every ~10 min · full sweep every ~30 min");
  });
});

describe("pickupPhrase", () => {
  it("in hours", () => { expect(pickupPhrase(view({}), NOW)).toBe("picked up within ~10 min"); });
  it("off hours", () => {
    expect(pickupPhrase(view({ in_hours: false, next_pickup_at: "2026-10-08T14:03:00Z" }), NOW)).toBe("next pickup Thu 10:03 ET");
  });
});
