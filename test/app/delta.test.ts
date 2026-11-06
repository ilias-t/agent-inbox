// The client's merge of GET /api/state/delta into the /api/state it holds (docs/api.md, "State delta": the merge
// contract). test/worker/delta.test.ts runs the same function against the real server over a random run of writes.
import { describe, expect, it } from "vitest";
import type { Doc, Item, Orchestrator, Principal, ScheduleView, StateDelta, StateResponse } from "../../shared/types.ts";
import { DeltaMismatch, mergeDelta } from "../../src/lib/delta.ts";

const at = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
function item(id: string, version = 1, status: Item["status"] = "open", created = 0): Doc<Item> {
  return { id, version, data: { type: "decision", title: id, status }, created_at: at(created), updated_at: at(version), updated_by: "test" };
}
function orch(id: string, version = 1): Doc<Orchestrator> {
  return { id, version, data: { title: id } as Orchestrator, created_at: at(0), updated_at: at(version), updated_by: "test" };
}
const me: Principal = { kind: "human", email: "you@test", role: "admin", is_admin: true };
const schedule = { schedule: { timezone: "UTC" }, computed: {} } as unknown as ScheduleView;

function snapshot(over: Partial<StateResponse> = {}): StateResponse {
  return {
    items: [item("a"), item("b"), item("old", 1, "archived")],
    orchestrators: [orch("O1"), orch("O2")],
    manager: null, lease: null, schedule, cursor: 10, me,
    people: [{ email: "you@test", has_topic: false }],
    snoozes: { a: "2030-01-01T00:00:00.000Z" },
    archived_total: 7, archived_more: true,
    ...over,
  };
}
function delta(over: Partial<StateDelta> = {}): StateDelta {
  return { cursor: 12, items: [], orchestrators: [], deleted: [], qa_changed: [], me, ...over };
}
const ids = (docs: { id: string }[]) => docs.map((d) => d.id).sort();

describe("mergeDelta: a delta applied to the /api/state the client holds", () => {
  it("upserts changed items and orchestrators by id and drops deleted ones", () => {
    const next = mergeDelta(snapshot(), delta({
      items: [item("a", 2), item("c")],
      orchestrators: [orch("O3")],
      deleted: [{ collection: "items", id: "b" }, { collection: "orchestrators", id: "O2" }],
    }));
    expect(ids(next.items)).toEqual(["a", "c", "old"]);
    expect(next.items.find((d) => d.id === "a")?.version).toBe(2);
    expect(ids(next.orchestrators)).toEqual(["O1", "O3"]);
  });

  it("ignores a deleted id it never held (created and deleted inside the window)", () => {
    const next = mergeDelta(snapshot(), delta({ deleted: [{ collection: "items", id: "never" }] }));
    expect(ids(next.items)).toEqual(["a", "b", "old"]);
  });

  it("moves the cursor and replaces me", () => {
    const promoted: Principal = { ...me, role: "viewer", is_admin: false };
    const next = mergeDelta(snapshot(), delta({ cursor: 15, me: promoted }));
    expect(next.cursor).toBe(15);
    expect(next.me).toEqual(promoted);
  });

  it("replaces each optional field that is present, null included, and leaves absent ones alone", () => {
    const s = snapshot({ manager: { id: "manager", version: 1 } as StateResponse["manager"] });
    const next = mergeDelta(s, delta({ manager: null, snoozes: {}, archived_total: 8 }));
    expect(next.manager).toBeNull();
    expect(next.snoozes).toEqual({});
    expect(next.archived_total).toBe(8);
    expect(next.people).toBe(s.people);
    expect(next.schedule).toBe(s.schedule);
    expect(next.lease).toBeNull();
  });

  it("replaces routines when a review routine changed, and keeps them (or their absence) otherwise", () => {
    const routines = [{ id: "review-bot", version: 3, last_run_at: at(5), result: "ok" as const }];
    const next = mergeDelta(snapshot({ routines: [] }), delta({ reviews_changed: ["review-bot"], routines }));
    expect(next.routines).toEqual(routines);
    expect(mergeDelta(next, delta({ cursor: 13 })).routines).toEqual(routines);
    // A snapshot from a Worker before reviews has none, and a delta without them leaves it so.
    expect(mergeDelta(snapshot(), delta())).not.toHaveProperty("routines");
  });

  it("keeps archived_more from the last full fetch (a delta never carries it)", () => {
    expect(mergeDelta(snapshot({ archived_more: true }), delta()).archived_more).toBe(true);
    expect(mergeDelta(snapshot({ archived_more: false }), delta()).archived_more).toBe(false);
  });

  it("keeps a held copy with a higher version of the same doc (a write result applied meanwhile)", () => {
    const s = snapshot({ items: [item("a", 5)] });
    expect(mergeDelta(s, delta({ items: [item("a", 4)] })).items[0].version).toBe(5);
  });

  it("takes the delta's copy of a doc recreated under the same id, whatever its version", () => {
    const s = snapshot({ items: [item("a", 5)] });
    const recreated = item("a", 1, "open", 30);
    expect(mergeDelta(s, delta({ items: [recreated] })).items[0]).toBe(recreated);
  });

  it("doesn't change the snapshot it was given", () => {
    const s = snapshot();
    const before = JSON.stringify(s);
    mergeDelta(s, delta({ items: [item("a", 2)], deleted: [{ collection: "items", id: "b" }], snoozes: {} }));
    expect(JSON.stringify(s)).toBe(before);
  });

  describe("refuses (DeltaMismatch: the caller fetches the full state instead)", () => {
    it("a cursor behind the one held", () => {
      expect(() => mergeDelta(snapshot({ cursor: 10 }), delta({ cursor: 9 }))).toThrow(DeltaMismatch);
    });

    it("a delta for someone else than the snapshot's signed-in identity", () => {
      const other: Principal = { ...me, email: "other@test" };
      expect(() => mergeDelta(snapshot(), delta({ me: other }))).toThrow(DeltaMismatch);
    });

    it("the same human with a differently cased email is the same identity", () => {
      expect(() => mergeDelta(snapshot(), delta({ me: { ...me, email: "You@Test" } }))).not.toThrow();
    });

    it("a reset", () => {
      expect(() => mergeDelta(snapshot(), { reset: true })).toThrow(DeltaMismatch);
    });

    it.each([
      ["items missing", { items: undefined }],
      ["deleted not a list", { deleted: {} }],
      ["cursor not a number", { cursor: "12" }],
      ["me missing", { me: undefined }],
      ["a doc without a version", { items: [{ id: "a", data: {} }] }],
    ])("a malformed body: %s", (_name, over) => {
      expect(() => mergeDelta(snapshot(), { ...delta(), ...over } as unknown as StateDelta)).toThrow(DeltaMismatch);
    });
  });

  describe("people's fleets map", () => {
    const entry = (label: string) => ({ doc: { ...orch("x"), id: label, data: { label } }, manager: null, lease: null, schedule });
    it("replaces the entries a delta brings and keeps the others", () => {
      const s = snapshot({ fleets: { default: entry("D"), fa: entry("A") } as StateResponse["fleets"] });
      const next = mergeDelta(s, delta({ fleets: { fa: entry("A2"), fb: entry("B") } as StateDelta["fleets"] }));
      expect(Object.keys(next.fleets!).sort()).toEqual(["default", "fa", "fb"]);
      expect(next.fleets!.fa.doc?.data.label).toBe("A2");
      expect(next.fleets!.default).toBe(s.fleets!.default);
      expect(mergeDelta(s, delta()).fleets).toBe(s.fleets);
    });

    it("merges a part of an entry into the held one", () => {
      const s = snapshot({ fleets: { fa: entry("A") } as StateResponse["fleets"] });
      const lease = { ...orch("lease:fa", 3), data: {} } as unknown as NonNullable<StateResponse["fleets"]>[string]["lease"];
      const next = mergeDelta(s, delta({ fleets: { fa: { lease } } }));
      expect(next.fleets!.fa.lease).toBe(lease);
      expect(next.fleets!.fa.doc).toBe(s.fleets!.fa.doc);
      expect(next.fleets!.fa.schedule).toBe(s.fleets!.fa.schedule);
    });

    it("refetches when it holds no map, or no entry for a part, to merge into", () => {
      expect(() => mergeDelta(snapshot(), delta({ fleets: { fa: entry("A") } as StateDelta["fleets"] }))).toThrow(DeltaMismatch);
      const s = snapshot({ fleets: { default: entry("D") } as StateResponse["fleets"] });
      expect(() => mergeDelta(s, delta({ fleets: { fb: { lease: null } } }))).toThrow(DeltaMismatch);
      expect(Object.keys(mergeDelta(s, delta({ fleets: { fb: entry("B") } as StateDelta["fleets"] })).fleets!)).toEqual(["default", "fb"]);
      for (const bad of [null, 3, [], { fa: null }, { fa: "x" }, { fa: [] }]) {
        expect(() => mergeDelta(s, { ...delta(), fleets: bad } as unknown as StateDelta)).toThrow(DeltaMismatch);
      }
    });
  });
});
