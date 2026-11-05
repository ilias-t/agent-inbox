import { describe, expect, it } from "vitest";
import { snoozePresets, snoozeZone } from "../../src/lib/snooze.ts";

const at = (iso: string) => Date.parse(iso);
const byId = (now: number, tz: string) => Object.fromEntries(snoozePresets(now, tz).map((p) => [p.id, p]));

describe("snoozePresets", () => {
  it("a weekday morning in New York: an hour, 6 pm today, 9 am tomorrow, 9 am Monday", () => {
    const p = byId(at("2026-10-07T14:00:00Z"), "America/New_York"); // Wed 10:00 EDT
    expect(p.hour.until).toBe("2026-10-07T15:00:00.000Z");
    expect(p.tonight).toMatchObject({ until: "2026-10-07T22:00:00.000Z", label: "Tonight (6 pm)" });
    expect(p.tomorrow.until).toBe("2026-10-08T13:00:00.000Z");
    expect(p.monday.until).toBe("2026-10-12T13:00:00.000Z");
  });

  it("keeps the order hour, tonight, tomorrow, Monday", () => {
    expect(snoozePresets(at("2026-10-07T14:00:00Z"), "America/New_York").map((p) => p.id)).toEqual(["hour", "tonight", "tomorrow", "monday"]);
  });

  it("after 6 pm, tonight becomes tomorrow at 6 pm", () => {
    const p = byId(at("2026-10-07T23:30:00Z"), "America/New_York"); // Wed 19:30 EDT
    expect(p.tonight).toMatchObject({ until: "2026-10-08T22:00:00.000Z", label: "Tomorrow 6 pm" });
  });

  it("at 6 pm sharp, tonight is already past", () => {
    const p = byId(at("2026-10-07T22:00:00Z"), "America/New_York");
    expect(p.tonight.until).toBe("2026-10-08T22:00:00.000Z");
  });

  it("counts days in the given zone, not UTC or the machine's", () => {
    const p = byId(at("2026-10-07T14:00:00Z"), "Asia/Tokyo"); // Wed 23:00 JST
    expect(p.tonight.until).toBe("2026-10-08T09:00:00.000Z"); // Thu 18:00 JST
    expect(p.tomorrow.until).toBe("2026-10-08T00:00:00.000Z"); // Thu 09:00 JST
    expect(p.monday.until).toBe("2026-10-12T00:00:00.000Z");
  });

  it("lands on 9 am local across the autumn DST change", () => {
    const p = byId(at("2026-10-31T16:00:00Z"), "America/New_York"); // Sat 12:00 EDT; clocks go back Sun 02:00
    expect(p.tonight.until).toBe("2026-10-31T22:00:00.000Z"); // 18:00 EDT
    expect(p.tomorrow.until).toBe("2026-11-01T14:00:00.000Z"); // 09:00 EST
    expect(p.monday.until).toBe("2026-11-02T14:00:00.000Z");
  });

  it("lands on 9 am local across the spring DST change", () => {
    const p = byId(at("2026-03-07T17:00:00Z"), "America/New_York"); // Sat 12:00 EST; clocks go forward Sun 02:00
    expect(p.tomorrow.until).toBe("2026-03-08T13:00:00.000Z"); // 09:00 EDT
    expect(p.hour.until).toBe("2026-03-07T18:00:00.000Z");
  });

  it("on a Monday, Monday means next week's", () => {
    const p = byId(at("2026-10-12T12:00:00Z"), "America/New_York"); // Mon 08:00 EDT
    expect(p.monday.until).toBe("2026-10-19T13:00:00.000Z");
  });

  it("on a Sunday, drops Monday: it is the same time as tomorrow", () => {
    const p = byId(at("2026-10-11T16:00:00Z"), "America/New_York"); // Sun 12:00 EDT
    expect(p.tomorrow.until).toBe("2026-10-12T13:00:00.000Z");
    expect(p.monday).toBeUndefined();
  });

  it("every preset is in the future", () => {
    const now = at("2026-10-07T23:59:00Z");
    for (const p of snoozePresets(now, "Pacific/Kiritimati")) expect(Date.parse(p.until)).toBeGreaterThan(now);
  });
});

describe("snoozeZone", () => {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  it("uses the schedule's zone", () => {
    expect(snoozeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
  it("falls back to the browser's zone without a schedule or with a bad zone", () => {
    expect(snoozeZone(undefined)).toBe(local);
    expect(snoozeZone("Nowhere/Land")).toBe(local);
  });
});
