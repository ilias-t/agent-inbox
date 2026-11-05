// The last good /api/state, saved on the device so the next open renders at once (src/lib/snapshot.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc, Item, Principal, StateResponse } from "../../shared/types.ts";
import { SNAPSHOT_ARCHIVED, STALE_MS, capSnapshot, clearSnapshot, isStale, readSnapshot, saveSnapshot, toSnapshot } from "../../src/lib/snapshot.ts";

const me: Principal = { kind: "human", email: "you@test", role: "admin", is_admin: true };
const at = (s: number) => new Date(Date.UTC(2026, 9, 1) + s * 1000).toISOString();
function item(id: string, updated: number, status: Item["status"] = "archived"): Doc<Item> {
  return { id, version: 1, data: { type: "decision", title: id, status }, created_at: at(0), updated_at: at(updated), updated_by: "t" };
}
function state(items: Doc<Item>[], over: Partial<StateResponse> = {}): StateResponse {
  return { items, orchestrators: [], manager: null, lease: null, schedule: null as never, cursor: 3, me, people: [], snoozes: {}, archived_total: 0, archived_more: false, ...over };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("capSnapshot: what is worth saving", () => {
  it("keeps every item that isn't archived and only the newest archived ones", () => {
    const archived = Array.from({ length: SNAPSHOT_ARCHIVED + 20 }, (_, i) => item("a" + String(i).padStart(3, "0"), i));
    const s = capSnapshot(state([item("open", 0, "open"), ...archived]));
    expect(s.items.filter((d) => d.data.status !== "archived").map((d) => d.id)).toEqual(["open"]);
    const kept = s.items.filter((d) => d.data.status === "archived").map((d) => d.id);
    expect(kept).toHaveLength(SNAPSHOT_ARCHIVED);
    expect(kept).toContain("a119");
    expect(kept).not.toContain("a019");
    expect(s.archived_more).toBe(true); // Load older starts below what was kept
  });

  it("orders archived ties by id, as the server pages them", () => {
    const archived = Array.from({ length: SNAPSHOT_ARCHIVED + 1 }, (_, i) => item("t" + String(i).padStart(3, "0"), 5));
    const kept = capSnapshot(state(archived)).items.map((d) => d.id);
    expect(kept).not.toContain("t000");
  });

  it("leaves a state within the cap as it was", () => {
    const s = state([item("open", 0, "open"), item("a", 1)]);
    expect(capSnapshot(s)).toEqual(s);
  });
});

describe("isStale: the saved copy is marked while it is old", () => {
  it("is fresh up to the limit and stale after it", () => {
    expect(isStale(1000, 1000 + STALE_MS)).toBe(false);
    expect(isStale(1000, 1000 + STALE_MS + 1)).toBe(true);
  });
});

describe("storage that isn't there or refuses (private mode, blocked site data) is skipped", () => {
  it("reads nothing and saves nothing without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(readSnapshot()).resolves.toBeNull();
    await expect(saveSnapshot(toSnapshot(state([]), 1))).resolves.toBeUndefined();
    await expect(clearSnapshot()).resolves.toBeUndefined();
  });

  it("reads nothing when opening the database throws", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("blocked", "SecurityError"); } });
    await expect(readSnapshot()).resolves.toBeNull();
    await expect(saveSnapshot(toSnapshot(state([]), 1))).resolves.toBeUndefined();
  });

  it("gives up on a database that never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("indexedDB", { open: () => ({}) }); // a request whose callbacks never fire
      const r = readSnapshot();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(r).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
