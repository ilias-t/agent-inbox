import { describe, expect, it } from "vitest";
import { absTime, clockTime, dayKey, dayLabel, relSpan, relTime, slotTime, toMs, zoneClock, zoneStamp } from "../../src/lib/time.ts";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("toMs", () => {
  it("parses ISO strings and epoch seconds or ms", () => {
    expect(toMs("2026-10-07T18:00:00Z")).toBe(NOW);
    expect(toMs(NOW / 1000)).toBe(NOW);
    expect(toMs(NOW)).toBe(NOW);
    expect(toMs("")).toBeNaN();
    expect(toMs(null)).toBeNaN();
  });
});

// What row titles and the header show; a long History formats thousands of these per render.
describe("absTime and clockTime", () => {
  const t = "2026-10-07T18:05:00Z";
  it("format in the browser's locale: month, day and time", () => {
    expect(absTime(t)).toBe(new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  });
  it("format the time of day", () => {
    expect(clockTime(t)).toBe(new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  });
  it("are empty for what isn't a time", () => {
    expect(absTime("soon")).toBe("");
    expect(clockTime(undefined)).toBe("");
  });
});

describe("relTime", () => {
  it("formats the past", () => {
    expect(relTime(ago(10_000), false, NOW)).toBe("just now");
    expect(relTime(ago(3 * 60_000), false, NOW)).toBe("3m ago");
    expect(relTime(ago(2 * 3600_000), false, NOW)).toBe("2h ago");
    expect(relTime(ago(3 * 86400_000), false, NOW)).toBe("3d ago");
  });
  it("formats the future and the compact form", () => {
    expect(relTime(ago(-7 * 60_000), false, NOW)).toBe("in 7m");
    expect(relTime(ago(3 * 60_000), true, NOW)).toBe("3m");
    expect(relTime(ago(10_000), true, NOW)).toBe("now");
    expect(relTime(ago(-90 * 60_000), true, NOW)).toBe("in 2h");
  });
  it("is empty for missing or bad input", () => {
    expect(relTime(undefined, false, NOW)).toBe("");
    expect(relTime("not a date", false, NOW)).toBe("");
  });
});

describe("relSpan", () => {
  it("carries the timestamp for the minute refresh", () => {
    const s = relSpan(ago(3 * 60_000), true, NOW);
    expect(s).toContain('data-ts="2026-10-07T17:57:00.000Z"');
    expect(s).toContain('data-compact="1"');
    expect(s).toContain(">3m</span>");
    expect(relSpan("nope")).toBe("");
  });
});

describe("slotTime", () => {
  const tz = "America/New_York";
  it("shows only the time for today, in the zone", () => {
    expect(slotTime("2026-10-07T18:23:00Z", tz, NOW)).toBe("14:23");
  });
  it("adds the weekday for another day and the zone when asked", () => {
    expect(slotTime("2026-10-08T14:03:00Z", tz, NOW, true)).toBe("Thu 10:03 ET");
    expect(slotTime("2026-10-07T21:03:00Z", tz, NOW, true, "today")).toBe("today 17:03 ET");
  });
});

describe("dayKey and dayLabel: History's day headers, in the schedule's zone", () => {
  const tz = "America/New_York"; // NOW is Wed 7 Oct 2026, 14:00 ET
  it("keys an instant by its calendar day in the zone, not in UTC", () => {
    expect(dayKey("2026-10-07T18:00:00Z", tz)).toBe("2026-10-07");
    expect(dayKey("2026-10-08T02:30:00Z", tz)).toBe("2026-10-07"); // 22:30 ET, still the 7th there
    expect(dayKey("2026-10-08T02:30:00Z", "UTC")).toBe("2026-10-08");
    expect(dayKey(undefined, tz)).toBe("");
  });
  it("a zone it doesn't know counts in UTC", () => {
    expect(dayKey("2026-10-08T02:30:00Z", "Nowhere/Atlantis")).toBe("2026-10-08");
  });
  it("names today and yesterday", () => {
    expect(dayLabel("2026-10-07", tz, NOW)).toBe("Today");
    expect(dayLabel("2026-10-06", tz, NOW)).toBe("Yesterday");
  });
  it("names other days by weekday, day and month", () => {
    expect(dayLabel("2026-10-05", tz, NOW)).toBe("Mon 5 Oct");
    expect(dayLabel("2026-09-30", tz, NOW)).toBe("Wed 30 Sep");
  });
  it("adds the year for another year", () => {
    expect(dayLabel("2025-12-31", tz, NOW)).toBe("Wed 31 Dec 2025");
  });
  it("today follows the zone: just after midnight ET it's already the 8th", () => {
    const late = Date.parse("2026-10-08T04:30:00Z"); // 00:30 ET on Thu 8 Oct
    expect(dayLabel("2026-10-08", tz, late)).toBe("Today");
    expect(dayLabel("2026-10-07", tz, late)).toBe("Yesterday");
  });
  it("across a month and a year boundary", () => {
    expect(dayLabel("2026-12-31", tz, Date.parse("2027-01-01T17:00:00Z"))).toBe("Yesterday");
  });
  it("an undated row", () => {
    expect(dayLabel("", tz, NOW)).toBe("Earlier");
  });
});

describe("zoneClock", () => {
  it("is the time of day in the zone", () => {
    expect(zoneClock("2026-10-07T13:12:00Z", "America/New_York")).toBe("09:12");
    expect(zoneClock("nope", "America/New_York")).toBe("");
  });
});

describe("zoneStamp: a History row's tooltip", () => {
  it("is the full time in the same zone as the row's clock, named", () => {
    expect(zoneStamp("2026-10-05T13:12:00Z", "America/New_York")).toBe("Mon 5 Oct 2026, 09:12 ET");
    expect(zoneStamp("2026-10-05T13:12:00Z", "UTC")).toBe("Mon 5 Oct 2026, 13:12 UTC");
    expect(zoneStamp(undefined, "UTC")).toBe("");
  });
});
