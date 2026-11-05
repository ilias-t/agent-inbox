import { describe, expect, it } from "vitest";
import type { ItemRow } from "../../src/lib/items.ts";
import { advanceTarget, neighbors, stepRow, triageOrder } from "../../src/lib/nav.ts";

const item = (over: Partial<ItemRow> & { id: string }): ItemRow => ({ type: "decision", title: "t", status: "open", ...over }) as ItemRow;
const at = (min: number) => new Date(Date.UTC(2026, 9, 7, 12, min)).toISOString();

// Index order: high asks, normal asks, low asks (oldest first in each), then FYI newest first.
const items: ItemRow[] = [
  item({ id: "n1", priority: "normal", created_at: at(1) }),
  item({ id: "fyi-old", type: "auto_decided", created_at: at(2) }),
  item({ id: "h2", priority: "high", created_at: at(5) }),
  item({ id: "low", priority: "low", created_at: at(0) }),
  item({ id: "h1", priority: "high", created_at: at(3) }),
  item({ id: "done", status: "decided", created_at: at(4) }),
  item({ id: "fyi-new", type: "auto_decided", created_at: at(9) }),
  item({ id: "gone", status: "archived", type: "auto_decided", created_at: at(8) }),
];
const decided = (list: ItemRow[], id: string) => list.map((i) => (i.id === id ? { ...i, status: "decided" as const } : i));

describe("triageOrder", () => {
  it("follows the index: priority groups oldest first, then FYI newest first, skipping closed items", () => {
    expect(triageOrder(items)).toEqual(["h1", "h2", "n1", "low", "fyi-new", "fyi-old"]);
  });
  it("is empty when nothing is open", () => {
    expect(triageOrder([item({ id: "a", status: "decided" })])).toEqual([]);
  });
});

describe("neighbors", () => {
  it("gives prev, next and the position inside the queue", () => {
    expect(neighbors(items, "n1")).toEqual({ prev: "h2", next: "low", index: 2, total: 6 });
  });
  it("crosses from the asks into the FYI group", () => {
    expect(neighbors(items, "low")).toMatchObject({ prev: "n1", next: "fyi-new" });
  });
  it("has no prev on the first item and no next on the last", () => {
    expect(neighbors(items, "h1")).toMatchObject({ prev: null, next: "h2", index: 0 });
    expect(neighbors(items, "fyi-old")).toMatchObject({ prev: "fyi-new", next: null, index: 5 });
  });
  it("keeps a decided item's place from the remembered order, skipping closed neighbours", () => {
    const remembered = triageOrder(items), after = decided(decided(items, "n1"), "low");
    expect(neighbors(after, "n1", remembered)).toEqual({ prev: "h2", next: "fyi-new", index: -1, total: 4 });
  });
  it("offers the first open item for an item that was never in the queue", () => {
    expect(neighbors(items, "done")).toEqual({ prev: null, next: "h1", index: -1, total: 6 });
    expect(neighbors([item({ id: "x", status: "decided" })], "x")).toEqual({ prev: null, next: null, index: -1, total: 0 });
  });
});

describe("advanceTarget", () => {
  const before = triageOrder(items);
  it("moves to the next item in the order", () => {
    expect(advanceTarget(before, "h2", decided(items, "h2"))).toBe("n1");
  });
  it("skips items that closed meanwhile (decided elsewhere, archived by the orchestrator)", () => {
    const after = decided(decided(items, "h2"), "n1");
    expect(advanceTarget(before, "h2", after)).toBe("low");
  });
  it("continues from the asks into the FYI group", () => {
    expect(advanceTarget(before, "low", decided(items, "low"))).toBe("fyi-new");
  });
  it("returns to the inbox (null) after the last item, even if skipped items above are still open", () => {
    expect(advanceTarget(before, "fyi-old", decided(items, "fyi-old"))).toBeNull();
  });
  it("returns to the inbox when the decided item wasn't in the queue", () => {
    expect(advanceTarget(before, "done", items)).toBeNull();
  });
  it("ignores items that arrived after the decision was sent", () => {
    const after = decided(items, "low").concat([item({ id: "new-high", priority: "high", created_at: at(10) })]);
    expect(advanceTarget(before, "low", after)).toBe("fyi-new");
  });
});

// The index row cursor outlives the focused element: live updates, coming back to the tab and
// visits to an item rebuild the list, so j/k step from the remembered row instead of an end.
describe("stepRow", () => {
  const rows = ["#item.a", "#item.b", "#item.c", "#item.d"];
  it("steps down with j and up with k from the cursor row", () => {
    expect(stepRow(rows, "#item.b", 1)).toBe("#item.c");
    expect(stepRow(rows, "#item.c", -1)).toBe("#item.b");
  });
  it("stays on the first and last rows instead of wrapping", () => {
    expect(stepRow(rows, "#item.a", -1)).toBe("#item.a");
    expect(stepRow(rows, "#item.d", 1)).toBe("#item.d");
  });
  it("starts at the top row in both directions when there is no cursor", () => {
    expect(stepRow(rows, null, 1)).toBe("#item.a");
    expect(stepRow(rows, null, -1)).toBe("#item.a"); // k never jumps to the bottom of the list
  });
  it("starts at the top row when the cursor row has left the list", () => {
    expect(stepRow(rows, "#item.gone", 1)).toBe("#item.a");
    expect(stepRow(rows, "#item.gone", -1)).toBe("#item.a");
  });
  it("returns null for an empty list", () => {
    expect(stepRow([], "#item.a", 1)).toBeNull();
  });
});

// The Inbox shows the viewer's pinned asks and FYI items first (src/lib/pins.ts pinInbox): the pager, the queue and
// where a decision goes next follow that order, not priority alone.
describe("with pins", () => {
  const now = Date.now();
  const pins = { "item:low": "2026-10-09T10:00:00.000Z", "item:fyi-old": "2026-10-09T09:00:00.000Z" };
  it("triageOrder puts the Pinned group first, newest pin first, as the list shows it", () => {
    expect(triageOrder(items, now, pins)).toEqual(["low", "fyi-old", "h1", "h2", "n1", "fyi-new"]);
    expect(triageOrder(items, now, {})).toEqual(triageOrder(items, now));
  });
  it("a pinned low-priority ask opened from the list is first, with Next on the next row", () => {
    expect(neighbors(items, "low", [], now, pins)).toEqual({ prev: null, next: "fyi-old", index: 0, total: 6 });
    expect(neighbors(items, "h1", [], now, pins)).toMatchObject({ prev: "fyi-old", next: "h2", index: 2 });
  });
  it("deciding it moves on to the next row shown, not back to the Inbox", () => {
    const before = triageOrder(items, now, pins), after = decided(items, "low");
    expect(advanceTarget(before, "low", after, now, pins)).toBe("fyi-old");
    // Still pinned once decided, it leaves the queue: its remembered place keeps prev and next.
    expect(neighbors(after, "low", before, now, pins)).toEqual({ prev: null, next: "fyi-old", index: -1, total: 5 });
  });
});
