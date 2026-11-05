// The live-update loop (src/store.ts watch) and its sync: what bringing the page back to the foreground costs, and
// how a change is fetched (a delta of the held /api/state, else the full state). document, window and fetch are
// stand-ins: the loop only needs visibility events and a /api server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, Doc, Item, Principal, StateDelta, StateResponse } from "../../shared/types.ts";

class FakeDocument extends EventTarget { hidden = false; }

interface Reply { status: number; body?: unknown }

let doc: FakeDocument;
let calls: string[];
let probeReply: Reply;
let deltaReply: Reply;
let deltaGate: Promise<void> | null;
let stopWatch: (() => void) | null = null;

const me: Principal = { kind: "human", email: "you@test", role: "admin", is_admin: true };
const change = (seq: number): Change => ({ seq, collection: "items", doc_id: "a", op: "update", version: 2, status: "open", actor: "token:m", at: "2026-10-07T12:00:00Z" });
const itemDoc = (id: string, version: number): Doc<Item> => ({ id, version, data: { type: "decision", title: id, status: "open" }, created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T12:00:00Z", updated_by: "t" });
const HELD = { items: [itemDoc("a", 1)], orchestrators: [], cursor: 5, me, archived_more: false } as unknown as StateResponse;
const STATE = { items: [itemDoc("a", 2)], orchestrators: [], cursor: 9, me } as unknown as StateResponse;
const DELTA: StateDelta = { cursor: 9, items: [itemDoc("a", 2)], orchestrators: [], deleted: [], qa_changed: ["a"], me };

// GET /api/changes?...&wait=20 holds until aborted, like a long-poll with nothing new; wait=0 answers probeReply.
function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  calls.push(init.method && init.method !== "GET" ? init.method + " " + url : url);
  const reply = (r: Reply) => Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }));
  if (url.startsWith("/api/state/delta")) return (deltaGate ?? Promise.resolve()).then(() => reply(deltaReply));
  if (url.startsWith("/api/state?")) return reply({ status: 200, body: STATE });
  if (url.startsWith("/api/changes") && url.endsWith("&wait=0")) return reply(probeReply);
  if (url.startsWith("/api/items/")) return reply({ status: 201, body: { message: {}, item: itemDoc("a", 3) } });
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function setVisible(visible: boolean): void {
  doc.hidden = !visible;
  doc.dispatchEvent(new Event("visibilitychange"));
}

const longPolls = () => calls.filter((u) => u.startsWith("/api/changes") && u.endsWith("&wait=20"));
const stateCalls = () => calls.filter((u) => u.startsWith("/api/state?"));
const deltaCalls = () => calls.filter((u) => u.startsWith("/api/state/delta"));

async function start(held: StateResponse | null = HELD) {
  const mod = await import("../../src/store.ts");
  const h = { base: vi.fn(() => held), onSync: vi.fn(), onChanges: vi.fn(), onHealth: vi.fn() };
  const signedOut = vi.fn();
  mod.onSignedOut(signedOut);
  const stop = mod.store.watch(5, h);
  stopWatch = stop;
  await vi.waitFor(() => expect(longPolls()).toHaveLength(1));
  return { h, signedOut, mod };
}

beforeEach(() => {
  vi.resetModules(); // store.ts keeps its signed-out flag per module instance
  doc = new FakeDocument();
  calls = [];
  probeReply = { status: 200, body: { cursor: 5, changes: [] } };
  deltaReply = { status: 200, body: DELTA };
  deltaGate = null;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => { stopWatch?.(); stopWatch = null; vi.unstubAllGlobals(); });

describe("watch: back in the foreground", () => {
  it("asks the change feed without waiting, and fetches nothing else when nothing changed", async () => {
    const { h } = await start();
    setVisible(false);
    setVisible(true);
    await vi.waitFor(() => expect(longPolls()).toHaveLength(2)); // the long-poll resumes after the check
    expect(calls).toEqual(["/api/changes?since=5&wait=20", "/api/changes?since=5&wait=0", "/api/changes?since=5&wait=20"]);
    expect(stateCalls()).toHaveLength(0);
    expect(deltaCalls()).toHaveLength(0);
    expect(h.onSync).not.toHaveBeenCalled();
  });

  it("fetches one delta from the held state's cursor when the check finds changes, then long-polls from the delta's cursor", async () => {
    probeReply = { status: 200, body: { cursor: 7, changes: [change(7)] } };
    const { h } = await start();
    setVisible(false);
    setVisible(true);
    await vi.waitFor(() => expect(h.onSync).toHaveBeenCalledTimes(1));
    expect(h.onChanges).toHaveBeenCalledWith([change(7)]);
    expect(deltaCalls()).toEqual(["/api/state/delta?since=5"]);
    expect(stateCalls()).toHaveLength(0);
    const r = h.onSync.mock.calls[0][0];
    expect(r.full).toBe(false);
    expect(r.state.items).toEqual([itemDoc("a", 2)]);
    expect(r.qa).toEqual(["a"]);
    await vi.waitFor(() => expect(calls).toContain("/api/changes?since=9&wait=20"));
  });

  it("still notices a signed-out session on that check", async () => {
    probeReply = { status: 401, body: { error: "unauthorized" } };
    const { signedOut } = await start();
    setVisible(false);
    setVisible(true);
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["/api/changes?since=5&wait=20", "/api/changes?since=5&wait=0"]); // and stops polling
  });

  it("replaces a long-poll still open when the page shows (no hidden event first) with the check, not counting it as a failure", async () => {
    const { h } = await start();
    setVisible(true);
    await vi.waitFor(() => expect(longPolls()).toHaveLength(2));
    expect(calls).toEqual(["/api/changes?since=5&wait=20", "/api/changes?since=5&wait=0", "/api/changes?since=5&wait=20"]);
    expect(stateCalls()).toHaveLength(0);
    expect(h.onHealth).not.toHaveBeenCalled();
  });

  it("drops a delta that overlapped a write and fetches it again", async () => {
    probeReply = { status: 200, body: { cursor: 7, changes: [change(7)] } };
    let open!: () => void;
    deltaGate = new Promise((r) => { open = r; });
    const { h, mod } = await start();
    setVisible(true);
    await vi.waitFor(() => expect(deltaCalls()).toHaveLength(1));
    deltaGate = null;
    await mod.store.ask("a", "why?");
    open();
    await vi.waitFor(() => expect(h.onSync).toHaveBeenCalledTimes(1));
    expect(deltaCalls()).toHaveLength(2);
  });
});

describe("ask: pinned only when the page asks it to be", () => {
  const bodies: unknown[] = [];
  beforeEach(() => {
    bodies.length = 0;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return fakeFetch(url, init); });
  });

  it("sends the version it was given (a question asked from a saved snapshot, not yet confirmed)", async () => {
    const { store } = await import("../../src/store.ts");
    await store.ask("a", "why?", 4);
    expect(bodies).toEqual([{ text: "why?", if_version: 4 }]);
  });

  it("sends no version otherwise: an answer landing meanwhile mustn't refuse the question", async () => {
    const { store } = await import("../../src/store.ts");
    await store.ask("a", "why?");
    expect(bodies).toEqual([{ text: "why?" }]);
  });
});

describe("sync: a delta of the held state, else the full state", () => {
  const sync = async (held: StateResponse | null) => (await import("../../src/store.ts")).store.sync(held);

  it("merges a delta into the held state", async () => {
    const r = await sync(HELD);
    expect(deltaCalls()).toEqual(["/api/state/delta?since=5"]);
    expect(stateCalls()).toHaveLength(0);
    expect(r).toMatchObject({ full: false, deleted: [], qa: ["a"] });
    expect(r.state.cursor).toBe(9);
    expect(r.state.archived_more).toBe(false); // the held one's
  });

  it("fetches the full state when nothing is held", async () => {
    const r = await sync(null);
    expect(deltaCalls()).toHaveLength(0);
    expect(r).toEqual({ full: true, state: STATE });
  });

  it.each([
    ["the server asks for a reset", { status: 200, body: { reset: true } }],
    ["the server has no delta route yet (404, mid-deploy)", { status: 404, body: { error: "not_found" } }],
    ["the delta route fails", { status: 500, body: { error: "internal" } }],
    ["the delta is for someone else", { status: 200, body: { ...DELTA, me: { ...me, email: "other@test" } } }],
    ["the delta's cursor is behind the held one", { status: 200, body: { ...DELTA, cursor: 3 } }],
  ])("falls back to the full state when %s", async (_why, reply) => {
    deltaReply = reply;
    const r = await sync(HELD);
    expect(deltaCalls()).toHaveLength(1);
    expect(stateCalls()).toHaveLength(1);
    expect(r).toEqual({ full: true, state: STATE });
  });

  it("stops at a signed-out session, without a full fetch", async () => {
    deltaReply = { status: 401, body: { error: "unauthorized" } };
    const mod = await import("../../src/store.ts");
    const signedOut = vi.fn();
    mod.onSignedOut(signedOut);
    await expect(mod.store.sync(HELD)).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(stateCalls()).toHaveLength(0);
  });

  it("stops at a network failure, without a full fetch", async () => {
    vi.stubGlobal("fetch", (url: string) => { calls.push(url); return Promise.reject(new TypeError("Failed to fetch")); });
    await expect(sync(HELD)).rejects.toMatchObject({ status: 0 });
    expect(calls).toEqual(["/api/state/delta?since=5"]);
  });
});
