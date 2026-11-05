import { describe, expect, it } from "vitest";
import type { ItemRow } from "../../src/lib/items.ts";
import { landingTarget, shouldLand, type LandingCheck } from "../../src/lib/landing.ts";

const item = (over: Partial<ItemRow> & { id: string }): ItemRow => ({ type: "decision", title: "t", status: "open", ...over }) as ItemRow;
const at = (min: number) => new Date(Date.UTC(2026, 9, 7, 12, min)).toISOString();
const NOW = Date.UTC(2026, 9, 7, 13, 0);

const base: LandingCheck = { first: true, layout: "phone", route: { view: "tab", tab: "inbox" }, explicitItem: false, landed: false, need: 3 };

describe("shouldLand: a phone opening on the Inbox goes to the top ask, once per session", () => {
  it("lands on a phone's first route, on the Inbox, with something that needs you", () => {
    expect(shouldLand(base)).toBe(true);
  });
  it("is still possible (pending) before the data loads", () => {
    expect(shouldLand({ ...base, need: undefined })).toBe(true);
  });
  it("stays on the Inbox when nothing needs you", () => {
    expect(shouldLand({ ...base, need: 0 })).toBe(false);
  });
  it("never on mid or desk: they open on the list", () => {
    expect(shouldLand({ ...base, layout: "mid" })).toBe(false);
    expect(shouldLand({ ...base, layout: "desk" })).toBe(false);
  });
  it("only on the first route, not a later navigation", () => {
    expect(shouldLand({ ...base, first: false })).toBe(false);
  });
  it("never overrides an item the app was opened on (a push tap)", () => {
    expect(shouldLand({ ...base, explicitItem: true })).toBe(false);
    expect(shouldLand({ ...base, route: { view: "item", id: "x" } })).toBe(false);
  });
  it("not again in a session that already decided it (a reload)", () => {
    expect(shouldLand({ ...base, landed: true })).toBe(false);
  });
  it("only from the Inbox: other tabs and pages stay where they are", () => {
    expect(shouldLand({ ...base, route: { view: "tab", tab: "history" } })).toBe(false);
    expect(shouldLand({ ...base, route: { view: "tab", tab: "team" } })).toBe(false);
    expect(shouldLand({ ...base, route: { view: "settings" } })).toBe(false);
    expect(shouldLand({ ...base, route: { view: "orch", id: "O3" } })).toBe(false);
  });
});

describe("landingTarget: the head of the queue among the open asks", () => {
  it("is the first ask in triage order: high first, oldest first", () => {
    const items = [
      item({ id: "n1", priority: "normal", created_at: at(0) }),
      item({ id: "h2", priority: "high", created_at: at(5) }),
      item({ id: "h1", priority: "high", created_at: at(3) }),
    ];
    expect(landingTarget(items, NOW)).toBe("h1");
  });
  it("skips FYI, closed and snoozed items", () => {
    const items = [
      item({ id: "fyi", type: "auto_decided", priority: "high", created_at: at(0) }),
      item({ id: "done", status: "decided", priority: "high", created_at: at(1) }),
      item({ id: "snz", priority: "high", created_at: at(2), snoozed_until: new Date(NOW + 3600_000).toISOString() }),
      item({ id: "ask", priority: "low", created_at: at(9) }),
    ];
    expect(landingTarget(items, NOW)).toBe("ask");
  });
  it("is null with only an FYI left, or nothing at all", () => {
    expect(landingTarget([item({ id: "fyi", type: "auto_decided" })], NOW)).toBeNull();
    expect(landingTarget([], NOW)).toBeNull();
  });
  it("counts a snooze that has woken", () => {
    expect(landingTarget([item({ id: "woke", snoozed_until: new Date(NOW - 60_000).toISOString() })], NOW)).toBe("woke");
  });
});
