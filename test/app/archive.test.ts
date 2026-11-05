import { describe, expect, it } from "vitest";
import type { Doc, Item } from "../../shared/types.ts";
import { mergePage, mergeState, oldestArchived, windowGap } from "../../src/lib/archive.ts";

const at = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
function doc(id: string, minute: number, status: Item["status"] = "archived", version = 1): Doc<Item> {
  return { id, version, data: { type: "decision", title: id, status }, created_at: at(0), updated_at: at(minute), updated_by: "test" };
}
const byId = (docs: Doc<Item>[]) => new Map(docs.map((d) => [d.id, d]));
const ids = (m: Map<string, Doc<Item>>) => [...m.keys()].sort();

describe("mergeState: a live /api/state refetch over what History has loaded", () => {
  it("keeps older archived items paged in earlier, beyond the refetch's window", () => {
    const prev = byId([doc("open", 50, "open"), doc("a-new", 40), doc("a-old", 10), doc("a-older", 5)]);
    const next = mergeState(prev, { items: [doc("open", 50, "open"), doc("a-new", 40)], archived_more: true });
    expect(ids(next)).toEqual(["a-new", "a-old", "a-older", "open"]);
  });

  it("keeps an archived item that just slid out of the window when a newer one was archived", () => {
    const prev = byId([doc("a2", 20), doc("a1", 10)]);
    const next = mergeState(prev, { items: [doc("a3", 30), doc("a2", 20)], archived_more: true });
    expect(ids(next)).toEqual(["a1", "a2", "a3"]);
  });

  it("replaces an item's copy with the refetched one, including one that left the archive", () => {
    const prev = byId([doc("x", 10), doc("y", 12)]);
    const reopened = doc("x", 60, "open", 2);
    const next = mergeState(prev, { items: [reopened, doc("y", 12)], archived_more: true });
    expect(next.get("x")).toBe(reopened);
  });

  it("drops an archived item missing from inside the window: it was deleted", () => {
    const prev = byId([doc("a3", 30), doc("gone", 25), doc("a1", 10)]);
    const next = mergeState(prev, { items: [doc("a3", 30), doc("a1", 10)], archived_more: true });
    expect(ids(next)).toEqual(["a1", "a3"]);
  });

  it("breaks a timestamp tie at the window's edge by id", () => {
    const prev = byId([doc("b", 10), doc("a", 10), doc("c", 10)]);
    // The window's oldest is (10, "b"): "a" sorts after it (older), "c" before it (inside, so deleted).
    const next = mergeState(prev, { items: [doc("b", 10)], archived_more: true });
    expect(ids(next)).toEqual(["a", "b"]);
  });

  it("drops every missing item when the refetch holds every archived item", () => {
    const prev = byId([doc("a2", 20), doc("a1", 10)]);
    const next = mergeState(prev, { items: [doc("a2", 20)], archived_more: false });
    expect(ids(next)).toEqual(["a2"]);
  });

  it("drops a missing item that wasn't archived: deleted, since a newly archived one would be in the window", () => {
    const prev = byId([doc("o", 5, "decided"), doc("a1", 10)]);
    const next = mergeState(prev, { items: [doc("a1", 10)], archived_more: true });
    expect(ids(next)).toEqual(["a1"]);
  });

  it("treats a server without archived_more as returning everything", () => {
    const prev = byId([doc("a1", 10)]);
    expect(ids(mergeState(prev, { items: [] }))).toEqual([]);
  });

  it("keeps every archived item when the refetch returned none of them but says there are more", () => {
    const prev = byId([doc("a1", 10)]);
    expect(ids(mergeState(prev, { items: [], archived_more: true }))).toEqual(["a1"]);
  });
});

describe("windowGap: a refetch whose window no longer touches what was loaded", () => {
  it("is false when a loaded archived item is inside the new window", () => {
    expect(windowGap(byId([doc("a2", 20), doc("a1", 10)]), { items: [doc("a3", 30), doc("a2", 20)], archived_more: true })).toBe(false);
  });
  it("is true when every loaded archived item is older than the new window: more were archived than it holds", () => {
    expect(windowGap(byId([doc("a2", 20), doc("a1", 10)]), { items: [doc("a9", 90), doc("a8", 80)], archived_more: true })).toBe(true);
  });
  it("is false when the refetch holds every archived item, or nothing archived was loaded", () => {
    expect(windowGap(byId([doc("a1", 10)]), { items: [doc("a9", 90)], archived_more: false })).toBe(false);
    expect(windowGap(byId([doc("o", 10, "open")]), { items: [doc("a9", 90)], archived_more: true })).toBe(false);
  });
});

describe("mergePage: a page of older archived items", () => {
  it("adds items not loaded yet", () => {
    const next = mergePage(byId([doc("a2", 20)]), [doc("a1", 10)]);
    expect(ids(next)).toEqual(["a1", "a2"]);
  });

  it("never replaces a newer copy with an older one", () => {
    const live = doc("a1", 30, "open", 3);
    const next = mergePage(byId([live]), [doc("a1", 10, "archived", 2)]);
    expect(next.get("a1")).toBe(live);
  });

  it("takes the page's copy when it is newer", () => {
    const fresh = doc("a1", 10, "archived", 4);
    expect(mergePage(byId([doc("a1", 10, "archived", 3)]), [fresh]).get("a1")).toBe(fresh);
  });
});

describe("oldestArchived: where Load older continues from", () => {
  it("is the archived doc with the oldest updated_at, ties by the smallest id", () => {
    expect(oldestArchived([doc("b", 10), doc("open", 1, "open"), doc("a", 10), doc("c", 20)])).toEqual({ at: at(10), id: "a" });
  });
  it("is null with no archived docs", () => {
    expect(oldestArchived([doc("open", 1, "open")])).toBeNull();
  });
});
