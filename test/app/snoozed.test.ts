import { describe, expect, it } from "vitest";
import { fyiItems, inboxCounts, isSnoozed, openItems, snoozedItems, type ItemRow } from "../../src/lib/items.ts";
import { advanceTarget, neighbors, triageOrder } from "../../src/lib/nav.ts";

const NOW = Date.parse("2026-10-07T14:00:00Z");
const LATER = "2026-10-07T18:00:00.000Z", SOONER = "2026-10-07T15:00:00.000Z", PAST = "2026-10-07T13:00:00.000Z";
const item = (over: Partial<ItemRow> & { id: string }): ItemRow =>
  ({ type: "decision", title: over.id, status: "open", created_at: "2026-10-01T00:00:00Z", ...over }) as ItemRow;

const items = [
  item({ id: "a" }),
  item({ id: "b", snoozed_until: LATER }),
  item({ id: "c", snoozed_until: PAST }), // woke up an hour ago
  item({ id: "d", type: "auto_decided", decision: { choice: "x", decided_at: "2026-10-01T00:00:00Z" } }),
  item({ id: "e", type: "auto_decided", snoozed_until: SOONER, decision: { choice: "x", decided_at: "2026-10-01T00:00:00Z" } }),
  item({ id: "f", status: "decided", snoozed_until: LATER }), // decided while snoozed: History's, not snoozed
];

describe("isSnoozed", () => {
  it("is true for an open item until its time passes", () => {
    expect(isSnoozed(items[1], NOW)).toBe(true);
    expect(isSnoozed(items[1], Date.parse(LATER))).toBe(false);
    expect(isSnoozed(items[2], NOW)).toBe(false);
  });
  it("ignores a closed item and an unparseable time", () => {
    expect(isSnoozed(items[5], NOW)).toBe(false);
    expect(isSnoozed(item({ id: "x", snoozed_until: "soon" }), NOW)).toBe(false);
  });
});

describe("snoozed items leave the Inbox until they wake", () => {
  it("openItems skips snoozed asks, and keeps one whose time has passed", () => {
    expect(openItems(items, NOW).map((i) => i.id)).toEqual(["a", "c"]);
  });
  it("fyiItems skips snoozed FYI items", () => {
    expect(fyiItems(items, NOW).map((i) => i.id)).toEqual(["d"]);
  });
  it("they come back once the time passes", () => {
    const after = Date.parse(LATER) + 1;
    expect(openItems(items, after).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(fyiItems(items, after).map((i) => i.id).sort()).toEqual(["d", "e"]);
  });
  it("snoozedItems lists open snoozed items, soonest wake first", () => {
    expect(snoozedItems(items, NOW).map((i) => i.id)).toEqual(["e", "b"]);
  });
  it("the badge and tab title count without them", () => {
    expect(inboxCounts(items, NOW)).toEqual({ need: 2, fyi: 1, snoozed: 2 });
  });
});

describe("snoozed items leave the triage order", () => {
  it("triageOrder skips them", () => {
    expect(triageOrder(items, NOW)).toEqual(["a", "c", "d"]);
  });
  it("prev/next step over them", () => {
    expect(neighbors(items, "a", [], NOW)).toMatchObject({ prev: null, next: "c", index: 0, total: 3 });
  });
  it("auto-advance skips an item snoozed meanwhile", () => {
    const order = ["a", "b", "c", "d"];
    expect(advanceTarget(order, "a", items, NOW)).toBe("c");
  });
});
