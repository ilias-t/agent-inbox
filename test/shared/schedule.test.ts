import { describe, expect, it } from "vitest";
import { computeSchedule, parseWorkHours, utcOffsetMin, validateSchedule } from "../../shared/schedule.ts";
import { DEFAULT_SCHEDULE, type Schedule } from "../../shared/types.ts";

const at = (iso: string) => new Date(iso);
const sched = (over: Partial<Schedule> = {}): Schedule => ({ ...DEFAULT_SCHEDULE, ...over });

describe("parseWorkHours", () => {
  it("parses ranges, single days and wrap-around day ranges", () => {
    expect(parseWorkHours("10:00-18:00 Mon-Fri")).toEqual({ start: 600, end: 1080, d0: 1, d1: 5 });
    expect(parseWorkHours("9:30-17:00 mon")).toEqual({ start: 570, end: 1020, d0: 1, d1: 1 });
    expect(parseWorkHours("00:00-24:00 Sat-Sun")).toEqual({ start: 0, end: 1440, d0: 6, d1: 0 });
    expect(parseWorkHours("08:00-12:00 Fri-Mon")).toEqual({ start: 480, end: 720, d0: 5, d1: 1 });
  });

  it("rejects malformed or empty windows", () => {
    for (const s of ["", "10-18 Mon-Fri", "10:00-18:00", "10:00-18:00 Mon-Fun", "18:00-10:00 Mon-Fri",
      "20:00-02:00 Mon-Fri", "10:00-10:00 Mon", "24:00-24:30 Mon", "10:60-11:00 Mon", "10:00-24:01 Mon"]) {
      expect(parseWorkHours(s), s).toBeNull();
    }
  });
});

describe("validateSchedule", () => {
  it("accepts and normalizes a valid schedule", () => {
    const r = validateSchedule({ ...DEFAULT_SCHEDULE, work_hours: "9:00-17:00 mon-thu", extra: 1 });
    expect(r).toEqual({ ok: true, schedule: { ...DEFAULT_SCHEDULE, work_hours: "09:00-17:00 Mon-Thu" } });
  });

  it.each([
    [null, "object"],
    [[], "object"],
    [{ ...DEFAULT_SCHEDULE, work_hours: "18:00-10:00 Mon-Fri" }, "work_hours"],
    [{ ...DEFAULT_SCHEDULE, timezone: "Mars/Olympus" }, "timezone"],
    [{ ...DEFAULT_SCHEDULE, timezone: "" }, "timezone"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 0 }, "integers"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 2.5 }, "integers"],
    [{ ...DEFAULT_SCHEDULE, sweep_interval_min: 241 }, "integers"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: "10" }, "integers"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 30, sweep_interval_min: 10 }, "sweep"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 7 }, "one of"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 45, sweep_interval_min: 60 }, "one of"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 90, sweep_interval_min: 90 }, "one of"],
    [{ ...DEFAULT_SCHEDULE, pickup_interval_min: 120, sweep_interval_min: 60 }, "sweep"],
  ])("rejects %j", (input, msg) => {
    const r = validateSchedule(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(msg);
  });
});

describe("computeSchedule", () => {
  it("defaults in EDT, inside hours", () => {
    // Wed 2026-10-07 14:05 EDT = 18:05Z
    const c = computeSchedule(sched(), at("2026-10-07T18:05:00Z"));
    expect(c).toEqual({
      now: "2026-10-07T18:05:00.000Z",
      in_hours: true,
      next_pickup_at: "2026-10-07T18:13:00.000Z",
      next_window_start: "2026-10-08T14:00:00.000Z",
      label: "10:00–18:00 ET, Mon–Fri",
      utc_offset_min: -240,
      cron_utc: ["3-59/10 14-21 * * 1-5"],
      cron_exact: true,
    });
  });

  it("a half-hour window in New York: superset cron, slots on the hour grid", () => {
    const s = sched({ work_hours: "09:30-17:30 Mon-Fri" });
    const inside = computeSchedule(s, at("2026-10-07T13:35:00Z")); // 09:35 EDT
    expect(inside.cron_utc).toEqual(["3-59/10 13-21 * * 1-5"]);
    expect(inside.cron_exact).toBe(false);
    expect(inside.in_hours).toBe(true);
    expect(inside.next_pickup_at).toBe("2026-10-07T13:43:00.000Z");
    // 09:03 EDT is a cron firing but outside hours; the first in-hours one is 09:33.
    const before = computeSchedule(s, at("2026-10-07T13:00:00Z"));
    expect(before.in_hours).toBe(false);
    expect(before.next_window_start).toBe("2026-10-07T13:30:00.000Z");
    expect(before.next_pickup_at).toBe("2026-10-07T13:33:00.000Z");
    // 17:25 EDT: 17:33 fires but is out of hours, so the next pickup is tomorrow.
    const late = computeSchedule(s, at("2026-10-07T21:25:00Z"));
    expect(late.next_pickup_at).toBe("2026-10-08T13:33:00.000Z");
  });

  it("Asia/Kolkata (+5:30): hours cover the window, not exact", () => {
    const s = sched({ timezone: "Asia/Kolkata", work_hours: "10:00-18:00 Mon-Fri" });
    const c = computeSchedule(s, at("2026-10-07T04:31:00Z")); // Wed 10:01 IST
    expect(c.utc_offset_min).toBe(330);
    expect(c.in_hours).toBe(true);
    expect(c.cron_utc).toEqual(["3-59/10 4-12 * * 1-5"]);
    expect(c.cron_exact).toBe(false);
    expect(c.next_pickup_at).toBe("2026-10-07T04:33:00.000Z"); // 10:03 IST
    const hourly = computeSchedule({ ...s, pickup_interval_min: 60, sweep_interval_min: 60 }, at("2026-10-07T04:31:00Z"));
    expect(hourly.cron_utc).toEqual(["3 4-12 * * 1-5"]);
    expect(hourly.next_pickup_at).toBe("2026-10-07T05:03:00.000Z"); // 10:33 IST
  });

  it("defaults in EST shift the cron by an hour", () => {
    const c = computeSchedule(sched(), at("2026-01-14T16:00:00Z")); // Wed 11:00 EST
    expect(c.utc_offset_min).toBe(-300);
    expect(c.cron_utc).toEqual(["3-59/10 15-22 * * 1-5"]);
    expect(c.in_hours).toBe(true);
    expect(c.next_pickup_at).toBe("2026-01-14T16:03:00.000Z");
  });

  it("a pickup exactly on a slot is that slot", () => {
    const c = computeSchedule(sched(), at("2026-10-07T18:13:00Z"));
    expect(c.next_pickup_at).toBe("2026-10-07T18:13:00.000Z");
  });

  it("before the window: next pickup is window start + 3", () => {
    const c = computeSchedule(sched(), at("2026-10-07T12:00:00Z")); // 08:00 EDT
    expect(c.in_hours).toBe(false);
    expect(c.next_window_start).toBe("2026-10-07T14:00:00.000Z");
    expect(c.next_pickup_at).toBe("2026-10-07T14:03:00.000Z");
  });

  it("end is exclusive and the last slot falls through to the next day", () => {
    const end = computeSchedule(sched(), at("2026-10-07T22:00:00Z")); // 18:00 EDT
    expect(end.in_hours).toBe(false);
    expect(end.next_pickup_at).toBe("2026-10-08T14:03:00.000Z");
    const late = computeSchedule(sched(), at("2026-10-07T21:55:00Z")); // 17:55, next slot 18:03 is out
    expect(late.in_hours).toBe(true);
    expect(late.next_pickup_at).toBe("2026-10-08T14:03:00.000Z");
  });

  it("weekend: next window is Monday", () => {
    const c = computeSchedule(sched(), at("2026-10-10T16:00:00Z")); // Sat noon EDT
    expect(c.in_hours).toBe(false);
    expect(c.next_window_start).toBe("2026-10-12T14:00:00.000Z");
    expect(c.next_pickup_at).toBe("2026-10-12T14:03:00.000Z");
  });

  it("next window across a DST change uses the new offset", () => {
    // Fri 2026-10-30 19:00 EDT; DST ends Sun Nov 1, so Monday 10:00 is EST.
    const c = computeSchedule(sched(), at("2026-10-30T23:00:00Z"));
    expect(c.next_window_start).toBe("2026-11-02T15:00:00.000Z");
  });

  it("next pickup is a cron firing on the day DST starts (the cron keeps today's offset)", () => {
    // Sun 2026-03-08 00:00 EST; clocks spring forward at 02:00, so 10:00 is EDT (14:00Z),
    // but the cron, built at the EST offset, only fires from 15:03Z.
    const s = sched({ work_hours: "10:00-18:00 Mon-Sun" });
    const c = computeSchedule(s, at("2026-03-08T05:00:00Z"));
    expect(c.cron_utc).toEqual(["3-59/10 15-22 * * *"]);
    expect(c.next_window_start).toBe("2026-03-08T14:00:00.000Z");
    expect(c.next_pickup_at).toBe("2026-03-08T15:03:00.000Z");
    const hourly = computeSchedule(sched({ work_hours: "10:00-18:00 Mon-Sun", pickup_interval_min: 60 }), at("2026-03-08T05:00:00Z"));
    expect(hourly.cron_utc).toEqual(["3 15-22 * * *"]);
    expect(hourly.next_pickup_at).toBe("2026-03-08T15:03:00.000Z");
  });

  it("same schedule a week before DST: next pickup is window start + 3", () => {
    const c = computeSchedule(sched({ work_hours: "10:00-18:00 Mon-Sun" }), at("2026-03-01T05:00:00Z"));
    expect(c.cron_utc).toEqual(["3-59/10 15-22 * * *"]);
    expect(c.next_window_start).toBe("2026-03-01T15:00:00.000Z");
    expect(c.next_pickup_at).toBe("2026-03-01T15:03:00.000Z");
  });

  it("a zone ahead of UTC splits the cron across UTC midnight (Tokyo)", () => {
    const s = sched({ timezone: "Asia/Tokyo", work_hours: "08:00-18:00 Mon-Fri" });
    const c = computeSchedule(s, at("2026-10-05T00:30:00Z")); // Mon 09:30 JST
    expect(c.utc_offset_min).toBe(540);
    expect(c.in_hours).toBe(true);
    expect(c.label).toBe("08:00–18:00 GMT+9, Mon–Fri");
    // Mon 08:00 JST = Sun 23:00Z.
    expect(c.cron_utc).toEqual(["3-59/10 23 * * 0-4", "3-59/10 0-8 * * 1-5"]);
    expect(c.next_pickup_at).toBe("2026-10-05T00:33:00.000Z");
  });

  it("a zone behind UTC splits the cron with the second half on the next day", () => {
    const s = sched({ timezone: "America/Los_Angeles", work_hours: "15:00-23:00 Mon-Fri" });
    const c = computeSchedule(s, at("2026-01-14T20:00:00Z"));
    expect(c.cron_utc).toEqual(["3-59/10 23 * * 1-5", "3-59/10 0-6 * * 2-6"]);
    expect(c.label).toBe("15:00–23:00 PT, Mon–Fri");
  });

  it("wrap-around days and a single day", () => {
    const wrap = computeSchedule(sched({ timezone: "UTC", work_hours: "22:00-24:00 Sat-Sun" }), at("2026-10-10T23:00:00Z"));
    expect(wrap.in_hours).toBe(true);
    expect(wrap.cron_utc).toEqual(["3-59/10 22-23 * * 0,6"]);
    expect(wrap.label).toBe("22:00–24:00 UTC, Sat–Sun");
    const one = computeSchedule(sched({ timezone: "UTC", work_hours: "09:00-10:00 Wed" }), at("2026-10-07T12:00:00Z"));
    expect(one.label).toBe("09:00–10:00 UTC, Wed");
    expect(one.next_window_start).toBe("2026-10-14T09:00:00.000Z");
  });

  it("hour-multiple intervals step hours", () => {
    const c = computeSchedule(sched({ pickup_interval_min: 120, sweep_interval_min: 120 }), at("2026-10-07T18:05:00Z"));
    expect(c.cron_utc).toEqual(["3 14-21/2 * * 1-5"]);
    expect(c.next_pickup_at).toBe("2026-10-07T20:03:00.000Z"); // 10:03, 12:03, 14:03, 16:03 EDT
  });

  it("utcOffsetMin handles half-hour zones", () => {
    expect(utcOffsetMin("Asia/Kolkata", Date.parse("2026-10-07T00:00:00Z"))).toBe(330);
  });
});
