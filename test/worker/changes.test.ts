import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

const cursorNow = async () => (await human.get("/api/changes")).body.cursor as number;

describe("change feed", () => {
  it("bootstraps a cursor, then returns changes since it", async () => {
    const boot = await human.get("/api/changes");
    expect(boot.body).toEqual({ cursor: expect.any(Number), changes: [] });
    const c0 = boot.body.cursor;
    const id = uid("ch");
    await createItem(id);
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    const r = await human.get(`/api/changes?since=${c0}`);
    expect(r.body.changes).toEqual([
      expect.objectContaining({ collection: "items", doc_id: id, op: "create", version: 1, status: "open", actor: "human:you@test" }),
      expect.objectContaining({ collection: "items", doc_id: id, op: "update", version: 2, status: "decided" }),
    ]);
    expect(r.body.cursor).toBe(r.body.changes[1].seq);
    const none = await human.get(`/api/changes?since=${r.body.cursor}`);
    expect(none.body).toEqual({ cursor: r.body.cursor, changes: [] });
  });

  it("filters by collection", async () => {
    const c0 = await cursorNow();
    const id = uid("ch");
    await createItem(id);
    await human.post(`/api/items/${id}/qa`, { text: "q" });
    await human.put(`/api/orchestrators/${uid("O")}`, { data: {} });
    const pick = async (collection: string) =>
      (await human.get(`/api/changes?since=${c0}&collection=${collection}`)).body.changes.map((c: any) => c.collection);
    expect(await pick("items")).toEqual(["items", "items"]);
    expect(await pick("qa")).toEqual([`items/${id}/qa`]);
    expect(await pick("orchestrators")).toEqual(["orchestrators"]);
    expect(await pick("meta")).toEqual([]);
    expect((await human.get(`/api/changes?since=${c0}&collection=nope`)).status).toBe(400);
    expect((await human.get("/api/changes?since=abc")).status).toBe(400);
  });

  it("long-poll returns when a write lands", async () => {
    const c0 = await cursorNow();
    const id = uid("lp");
    const started = Date.now();
    const poll = human.get(`/api/changes?since=${c0}&wait=10`);
    setTimeout(() => void createItem(id), 300);
    const r = await poll;
    expect(r.body.changes.map((c: any) => c.doc_id)).toContain(id);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("long-poll gives up after wait with no changes", async () => {
    const c0 = await cursorNow();
    const started = Date.now();
    const r = await human.get(`/api/changes?since=${c0}&wait=1`);
    expect(r.body).toEqual({ cursor: c0, changes: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("long-poll stops querying once the client disconnects", async () => {
    // A D1 that counts the feed's queries; everything else passes through.
    let feedQueries = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop, target);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("FROM changes")) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return { all: () => (feedQueries++, bound.all()) };
            },
          };
        };
      },
    });
    const c0 = await cursorNow();
    const abort = new AbortController();
    const ctx = createExecutionContext();
    let settledAfter = Infinity;
    const started = Date.now();
    const res = worker
      .fetch(new Request(`http://localhost/api/changes?since=${c0}&wait=10`, { signal: abort.signal }), { ...env, DB: db }, ctx)
      .finally(() => (settledAfter = Date.now() - started));
    setTimeout(() => abort.abort(), 300);
    // Past the 1.5 s poll interval: a loop still running would have queried again.
    await new Promise((r) => setTimeout(r, 2000));
    expect(feedQueries).toBe(1);
    // The pending sleep is cut short on abort, not left to run out.
    expect(settledAfter).toBeLessThan(1000);
    await res;
    await waitOnExecutionContext(ctx);
  });

  it("orchestrator tokens see deletes of their items and qa, and keep history after a reassign", async () => {
    const o = uid("O");
    const orch = agent((await mintToken("orchestrator", o)).secret);
    const c0 = await cursorNow();
    const gone = uid("gone");
    const moved = uid("moved");
    await createItem(gone, { orchestrator: o });
    await human.post(`/api/items/${gone}/qa`, { text: "q" });
    await createItem(moved, { orchestrator: o });
    await human.patch(`/api/items/${moved}`, { data: { orchestrator: "O-elsewhere" } });
    await human.patch(`/api/items/${moved}`, { data: { summary: "not yours any more" } });
    await human.del(`/api/items/${gone}`);

    const seen = (await orch.get(`/api/changes?since=${c0}`)).body.changes.map(
      (c: any) => `${c.op} ${c.collection.startsWith("items/") ? "qa" : c.collection}:${c.collection.startsWith("items/") ? "-" : c.doc_id}`,
    );
    expect(seen).toEqual([
      `create items:${gone}`,
      `update items:${gone}`, // qa_pending
      "create qa:-",
      `create items:${moved}`,
      "delete qa:-", // qa goes first, while the item still names its orchestrator
      `delete items:${gone}`,
    ]);
  });

  it("orchestrator tokens see only their items, qa and orchestrator doc", async () => {
    const o = uid("O");
    const orch = agent((await mintToken("orchestrator", o)).secret);
    const c0 = await cursorNow();
    const mine = uid("mine");
    const theirs = uid("theirs");
    await createItem(mine, { orchestrator: o });
    await createItem(theirs, { orchestrator: "O-other" });
    await human.post(`/api/items/${mine}/qa`, { text: "q" });
    await human.post(`/api/items/${theirs}/qa`, { text: "q" });
    await human.put(`/api/orchestrators/${o}`, { data: {} });
    await human.put(`/api/orchestrators/O-other`, { data: {} });
    await human.post("/api/meta/manager/tick-request");
    const r = await orch.get(`/api/changes?since=${c0}`);
    // Creation order: item, then the qa batch (item update, message insert).
    expect(r.body.changes.map((c: any) => (c.collection === "items" || c.collection === "orchestrators" ? `${c.collection}:${c.doc_id}` : c.collection))).toEqual([
      `items:${mine}`,
      `items:${mine}`,
      `items/${mine}/qa`,
      `orchestrators:${o}`,
    ]);
  });
});
