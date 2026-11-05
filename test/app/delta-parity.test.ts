// The page's live state, fed deltas, stays what a fresh /api/state would give it, with older History pages loaded
// on top: the client-side half of test/worker/delta.test.ts's property (which runs the same merge against the real
// server). A small in-memory server stands in for /api/state?archived=n, /api/state/delta and History's pages,
// over a seeded random run of writes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Item, Orchestrator, Principal, ScheduleView, StateDelta, StateResponse } from "../../shared/types.ts";
import { deletedItems, mergeDelta } from "../../src/lib/delta.ts";
import { rng } from "../worker/delta-merge.ts";

type StateMod = typeof import("../../src/state.ts");
const me: Principal = { kind: "human", email: "you@test", role: "admin", is_admin: true };
const schedule = { schedule: { timezone: "UTC" }, computed: {} } as unknown as ScheduleView;

class FakeServer {
  items = new Map<string, Doc<Item>>();
  orchs = new Map<string, Doc<Orchestrator>>();
  snoozes: Record<string, string> = {};
  pins: Record<string, string> = {};
  log: { seq: number; collection: string; id: string }[] = [];
  seq = 0;
  private clock = 0;
  private n = 0;
  constructor(private window: number) {}

  private now(): string { return new Date(Date.UTC(2026, 8, 1) + ++this.clock * 1000).toISOString(); }
  private logged(collection: string, id: string): void { this.log.push({ seq: ++this.seq, collection, id }); }
  newId(p: string): string { return p + ++this.n; }

  putItem(id: string, status: Item["status"]): void {
    const cur = this.items.get(id), at = this.now();
    this.items.set(id, { id, version: (cur?.version ?? 0) + 1, data: { type: "decision", title: id, status }, created_at: cur?.created_at ?? at, updated_at: at, updated_by: "test" });
    this.logged("items", id);
  }
  deleteItem(id: string): void {
    this.items.delete(id); this.logged("items", id);
    if (id in this.snoozes) { delete this.snoozes[id]; this.logged("snoozes", id); }
    if ("item:" + id in this.pins) { delete this.pins["item:" + id]; this.logged("pins", "item:" + id); }
  }
  putOrch(id: string): void {
    const cur = this.orchs.get(id), at = this.now();
    this.orchs.set(id, { id, version: (cur?.version ?? 0) + 1, data: { title: id } as Orchestrator, created_at: cur?.created_at ?? at, updated_at: at, updated_by: "test" });
    this.logged("orchestrators", id);
  }
  deleteOrch(id: string): void {
    this.orchs.delete(id); this.logged("orchestrators", id);
    if ("orch:" + id in this.pins) { delete this.pins["orch:" + id]; this.logged("pins", "orch:" + id); }
  }
  pin(key: string, on: boolean): void {
    if (on) this.pins[key] ??= this.now(); else delete this.pins[key];
    this.logged("pins", key);
  }
  snooze(id: string, until: string | null): void {
    if (until) this.snoozes[id] = until; else delete this.snoozes[id];
    this.logged("snoozes", id);
  }

  // Newest first, ties by id descending: the paging order of /api/items and the archived window.
  private archived(): Doc<Item>[] {
    return [...this.items.values()].filter((d) => d.data.status === "archived")
      .sort((a, b) => (a.updated_at !== b.updated_at ? (a.updated_at < b.updated_at ? 1 : -1) : a.id < b.id ? 1 : -1));
  }
  state(): StateResponse {
    const arch = this.archived();
    return {
      items: [...this.items.values()].filter((d) => d.data.status !== "archived").concat(arch.slice(0, this.window)),
      orchestrators: [...this.orchs.values()],
      manager: null, lease: null, schedule, cursor: this.seq, me, people: [],
      snoozes: { ...this.snoozes }, pins: { ...this.pins }, archived_total: arch.length, archived_more: arch.length > this.window,
    };
  }
  delta(since: number): StateDelta {
    const d: StateDelta = { cursor: this.seq, items: [], orchestrators: [], deleted: [], qa_changed: [], me, archived_total: this.archived().length };
    const seen = new Set<string>();
    for (const c of this.log) {
      const key = c.collection + "/" + c.id;
      if (c.seq <= since || seen.has(key)) continue;
      seen.add(key);
      if (c.collection === "snoozes") d.snoozes = { ...this.snoozes };
      else if (c.collection === "pins") d.pins = { ...this.pins };
      else if (c.collection === "items") { const x = this.items.get(c.id); if (x) d.items.push(x); else d.deleted.push({ collection: "items", id: c.id }); }
      else { const x = this.orchs.get(c.id); if (x) d.orchestrators.push(x); else d.deleted.push({ collection: "orchestrators", id: c.id }); }
    }
    return d;
  }
  // GET /api/items?status=archived&before=&before_id=&limit=
  page(cursor: { at: string; id: string } | null, limit: number): { items: Doc<Item>[]; more: boolean } {
    const older = this.archived().filter((d) => !cursor || d.updated_at < cursor.at || (d.updated_at === cursor.at && d.id < cursor.id));
    return { items: older.slice(0, limit), more: older.length > limit };
  }
}

let S: StateMod;
beforeEach(async () => {
  vi.resetModules(); // a fresh page: src/state.ts holds module-level state
  S = await import("../../src/state.ts");
});

function pullDelta(server: FakeServer): void {
  const d = server.delta(S.state.base!.cursor);
  S.applySync({ full: false, state: mergeDelta(S.state.base!, d), deleted: deletedItems(d), qa: d.qa_changed });
}
function loadOlder(server: FakeServer, limit: number): void {
  const p = server.page(S.state.archive.cursor, limit);
  S.applyOlderPage(p.items, p.more);
}

// What the page holds must be the server's current docs: nothing stale, nothing deleted, everything a fresh
// /api/state holds, plus older archived ones History paged in.
function expectInSync(server: FakeServer, step: number): void {
  const fresh = server.state();
  for (const [id, d] of S.state.docs) expect(d, `step ${step}: ${id}`).toEqual(server.items.get(id));
  for (const d of fresh.items) expect(S.state.docs.has(d.id), `step ${step}: missing ${d.id}`).toBe(true);
  expect(S.state.items.map((r) => r.id).sort(), `step ${step}`).toEqual([...S.state.docs.keys()].sort());
  expect(S.state.versions.get(fresh.items[0]?.id ?? ""), `step ${step}`).toBe(fresh.items[0]?.version);
  expect(S.state.orchestrators.map((o) => o.id).sort(), `step ${step}`).toEqual([...server.orchs.keys()].sort());
  expect(S.state.snoozes, `step ${step}`).toEqual(server.snoozes);
  expect(S.state.pins, `step ${step}`).toEqual(server.pins);
  expect(S.state.archive.total, `step ${step}`).toBe(fresh.archived_total);
  expect(S.state.cursor, `step ${step}`).toBe(server.seq);
}

describe("live state fed deltas", () => {
  it("equals a fresh /api/state over a random run of writes, keeping the History pages loaded", () => {
    const R = rng(20261008);
    const server = new FakeServer(4);
    for (let i = 0; i < 12; i++) server.putItem(server.newId("a"), "archived");
    for (let i = 0; i < 4; i++) server.putItem(server.newId("o"), "open");
    server.putOrch("O1");
    S.applySync({ full: true, state: server.state() });
    loadOlder(server, 3); // History paged in a few older ones

    const ids = () => [...server.items.keys()];
    const ops: (() => void)[] = [
      () => server.putItem(server.newId("o"), "open"),
      () => { const id = R.pick(ids()); if (id) server.putItem(id, server.items.get(id)!.data.status); },
      () => { const id = R.pick(ids()); if (id) server.putItem(id, "archived"); },
      () => { const id = R.pick(ids()); if (id) server.putItem(id, "open"); },
      () => { const id = R.pick(ids()); if (id) server.deleteItem(id); },
      () => server.putOrch(server.newId("O")),
      () => { const id = R.pick([...server.orchs.keys()]); if (id) server.deleteOrch(id); },
      () => { const id = R.pick(ids()); if (id) server.snooze(id, R.next() < 0.5 ? null : "2030-01-01T00:00:00.000Z"); },
      () => { const id = R.pick(ids()); if (id) server.pin("item:" + id, R.next() < 0.7); },
      () => { const id = R.pick([...server.orchs.keys()]); if (id) server.pin("orch:" + id, R.next() < 0.7); },
    ];
    for (let step = 0; step < 300; step++) {
      for (let k = 1 + R.int(3); k > 0; k--) R.pick(ops)();
      pullDelta(server);
      if (R.next() < 0.1 && S.state.archive.more) loadOlder(server, 2);
      expectInSync(server, step);
    }

    // Load older still reaches every archived item, none twice.
    while (S.state.archive.more) loadOlder(server, 3);
    expect([...S.state.docs.keys()].sort()).toEqual(ids().sort());
  });

  it("drops an older archived item History loaded when a delta deletes it", () => {
    const server = new FakeServer(2);
    for (let i = 0; i < 6; i++) server.putItem(server.newId("a"), "archived");
    S.applySync({ full: true, state: server.state() });
    loadOlder(server, 4);
    expect(S.state.docs.has("a1")).toBe(true);
    server.deleteItem("a1");
    pullDelta(server);
    expect(S.state.docs.has("a1")).toBe(false);
    expect(S.state.items.some((r) => r.id === "a1")).toBe(false);
  });

  it("a full fetch for another identity replaces everything held, older pages included", () => {
    const server = new FakeServer(2);
    for (let i = 0; i < 6; i++) server.putItem(server.newId("a"), "archived");
    S.applySync({ full: true, state: server.state() });
    loadOlder(server, 4);
    const other: StateResponse = { ...server.state(), items: [], archived_total: 0, archived_more: false, me: { ...me, email: "other@test" } };
    S.applySync({ full: true, state: other });
    expect(S.state.docs.size).toBe(0);
    expect(S.state.me).toEqual(other.me);
  });

  it("a full fetch revalidating a saved snapshot replaces it: archived items deleted meanwhile don't linger", () => {
    const server = new FakeServer(3);
    for (let i = 0; i < 6; i++) server.putItem(server.newId("a"), "archived");
    S.applyState(server.state()); // the snapshot saved on the device (a6, a5, a4), rendered at boot
    server.deleteItem("a5"); // then two newer ones archived: the window is a8, a7, a6
    for (let i = 0; i < 2; i++) server.putItem(server.newId("a"), "archived");
    S.applySync({ full: true, state: server.state() }); // the delta asked for a reset
    expect(S.state.docs.has("a5")).toBe(false);
    expect(S.state.revalidated).toBe(true);
    expectInSync(server, 0);
  });

  it("takes a full fetch's cursor even when it is lower (another database, say after a reseed)", () => {
    const server = new FakeServer(2);
    server.putItem("x", "open");
    S.applySync({ full: true, state: { ...server.state(), cursor: 5000 } });
    S.applySync({ full: true, state: server.state() });
    expect(S.state.cursor).toBe(server.seq);
  });
});
