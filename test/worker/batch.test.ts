// POST /api/batch: several writes in one D1 transaction, all or nothing.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index.ts";
import { getDoc, mutateMany } from "../../worker/store.ts";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

let manager: ReturnType<typeof agent>;
let managerSecret: string;
beforeAll(async () => {
  managerSecret = (await mintToken("manager", undefined, "mgr-batch")).secret;
  manager = agent(managerSecret);
});

const seq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;
const qaCount = async (id: string) =>
  (await env.DB.prepare("SELECT count(*) AS n FROM docs WHERE collection = ?").bind(`items/${id}/qa`).first<{ n: number }>())!.n;
const item = (id: string) => getDoc<any>(env.DB, "items", id);

describe("D1 batch semantics the endpoint relies on", () => {
  it("a pinned UPDATE that matches no row does not roll back the rest of a batch", async () => {
    const a = uid("raw"), b = uid("raw");
    await createItem(a);
    await env.DB.batch([
      env.DB.prepare("UPDATE docs SET version = version + 1 WHERE collection = 'items' AND id = ? AND version = 99").bind(a),
      env.DB.prepare(
        "INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES ('items', ?, '{}', 'x', 'x')",
      ).bind(b),
    ]);
    expect(await item(b)).not.toBeNull(); // so the batch needs a statement that fails
  });
});

describe("batch", () => {
  it("runs every op in one transaction and answers each op's own response", async () => {
    const decided = uid("b"), asked = uid("b"), fresh = uid("b"), o = uid("O");
    await createItem(decided);
    await human.post(`/api/items/${decided}/decide`, { choice: "ack" }); // v2
    await createItem(asked);
    await human.post(`/api/items/${asked}/qa`, { text: "why?" }); // v2
    await manager.put(`/api/orchestrators/${o}`, { data: { goal: "g", status: "running" } });
    await manager.put("/api/meta/manager", { data: {} });
    const before = await seq();

    const r = await manager.post("/api/batch", {
      ops: [
        { op: "item.claim", id: decided, if_version: 2 },
        { op: "item.qa", id: asked, text: "because", if_version: 2, data: { summary: "answered" } },
        { op: "item.put", id: fresh, data: { type: "info", title: "FYI" }, if_version: 0 },
        { op: "orchestrator.patch", id: o, data: { status: "pr-open" } },
        { op: "meta.patch", id: "manager", data: { digest: "d", last_pickup: "now" } },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [claimed, answered, created, orch, meta] = r.body.results;
    expect(claimed).toMatchObject({ id: decided, version: 3, data: { status: "processing" }, updated_by: "token:mgr-batch" });
    expect(answered.message.data).toMatchObject({ role: "manager", text: "because" });
    expect(answered.item).toMatchObject({ version: 3, data: { qa_pending: false, summary: "answered" } });
    expect(created).toMatchObject({ id: fresh, version: 1, data: { type: "info", status: "open" } });
    expect(orch).toMatchObject({ id: o, data: { status: "pr-open", goal: "g" } });
    expect(meta).toMatchObject({ id: "manager", data: { digest: "d" } });
    expect(await qaCount(asked)).toBe(2);
    // Change-log triggers fire per write: claim, item update + qa insert, create, orch, meta.
    expect((await seq()) - before).toBe(6);
  });

  it("works for humans on /api too", async () => {
    const id = uid("h");
    const r = await human.post("/api/batch", { ops: [{ op: "item.put", id, data: { type: "info", title: "t" } }] });
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ id, updated_by: "human:you@test" });
  });

  describe("a failed pin mid-batch writes nothing", () => {
    it("409 conflict names the op and carries its current doc", async () => {
      const a = uid("p"), b = uid("p"), c = uid("p"), fresh = uid("p");
      await createItem(a);
      await createItem(b);
      await human.post(`/api/items/${b}/qa`, { text: "q" }); // b is v2
      await createItem(c);
      const before = await seq();
      const r = await manager.post("/api/batch", {
        ops: [
          { op: "item.patch", id: a, data: { summary: "s" }, if_version: 1 },
          { op: "item.put", id: fresh, data: { type: "proposal", title: "new" }, if_version: 0 },
          { op: "item.qa", id: b, text: "stale answer", if_version: 1 },
          { op: "item.archive", id: c },
        ],
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "conflict", index: 2, current: { id: b, version: 2 } });
      expect((await item(a))!.version).toBe(1);
      expect(await item(fresh)).toBeNull();
      expect((await item(c))!.data.status).toBe("open");
      expect(await qaCount(b)).toBe(1);
      expect(await seq()).toBe(before);
    });

    it("an op's own rule failing (not_decided) is reported with its index too", async () => {
      const a = uid("p"), b = uid("p");
      await createItem(a);
      await createItem(b);
      const r = await manager.post("/api/batch", {
        ops: [
          { op: "item.archive", id: a },
          { op: "item.claim", id: b },
        ],
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "not_decided", index: 1, current: { id: b } });
      expect((await item(a))!.data.status).toBe("open");
    });

    it("a write that loses a race after the read: pinned → 409 with index; unpinned → rebuilt", async () => {
      const a = uid("race"), b = uid("race");
      await createItem(a);
      await createItem(b);
      const sneak = (id: string) =>
        env.DB.prepare(
          "UPDATE docs SET version = version + 1, data = json_set(data, '$.sneaky', 1) WHERE collection = 'items' AND id = ?",
        ).bind(id).run();
      const opts = { actor: "test", now: new Date().toISOString() };

      let raced = false;
      const pinned = mutateMany(env.DB, [
        { collection: "items", id: a, build: (cur: any) => ({ ...cur.data, first: true }) },
        {
          collection: "items",
          id: b,
          ifVersion: 1,
          build: async (cur: any) => {
            if (!raced) (raced = true), await sneak(b); // lands between the read and the batch
            return { ...cur.data, second: true };
          },
        },
      ], opts);
      await expect(pinned).rejects.toMatchObject({ status: 409, code: "conflict", index: 1 });
      expect((await item(a))!.version).toBe(1);
      expect((await item(b))!.version).toBe(2);

      let raced2 = false;
      const [ra, rb] = await mutateMany(env.DB, [
        { collection: "items", id: a, build: (cur: any) => ({ ...cur.data, first: true }) },
        {
          collection: "items",
          id: b,
          build: async (cur: any) => {
            if (!raced2) (raced2 = true), await sneak(b);
            return { ...cur.data, second: true };
          },
        },
      ], opts);
      expect(ra.doc).toMatchObject({ version: 2, data: { first: true } });
      expect(rb.doc).toMatchObject({ version: 4, data: { second: true, sneaky: 1 } });
    });
  });

  describe("authorization is per op, as if each were sent alone", () => {
    let orch: ReturnType<typeof agent>;
    const O = uid("O");
    beforeAll(async () => {
      orch = agent((await mintToken("orchestrator", O, uid("orch-batch"))).secret);
    });

    it("an orchestrator token may batch its own item writes, qa answers and orchestrator doc", async () => {
      const id = uid("o");
      await createItem(id, { orchestrator: O });
      await human.post(`/api/items/${id}/qa`, { text: "q" });
      const r = await orch.post("/api/batch", {
        ops: [
          { op: "orchestrator.put", id: O, data: { goal: "g" } },
          { op: "item.put", id: uid("o"), data: { type: "blocker", title: "stuck", orchestrator: O } },
          { op: "item.qa", id, text: "answer", data: { summary: "s" } },
        ],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.results[2].message.data.role).toBe("orchestrator");
    });

    it("an orchestrator token may archive its own decided item, pinned, as it could alone", async () => {
      const id = uid("o"), open = uid("o");
      await createItem(id, { orchestrator: O, source: O });
      await createItem(open, { orchestrator: O, source: O });
      const { version } = (await human.post(`/api/items/${id}/decide`, { choice: "ack" })).body;
      const r = await orch.post("/api/batch", {
        ops: [
          { op: "item.patch", id: open, data: { summary: "next question" } },
          { op: "item.archive", id, if_version: version },
        ],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.results[1]).toMatchObject({ id, data: { status: "archived" } });
      // Unpinned is refused at that op's index before anything is written.
      const other = uid("o");
      await createItem(other, { orchestrator: O, source: O });
      await human.post(`/api/items/${other}/decide`, { choice: "ack" });
      const bad = await orch.post("/api/batch", { ops: [{ op: "item.patch", id: other, data: {} }, { op: "item.archive", id: other }] });
      expect(bad.status).toBe(400);
      expect(bad.body.index).toBe(1);
    });

    it("an op it couldn't do alone fails the batch with 403 and that op's index", async () => {
      const own = uid("o"), other = uid("o");
      await createItem(own, { orchestrator: O });
      await createItem(other, { orchestrator: "someone-else" });
      const cases: [unknown[], number][] = [
        [[{ op: "item.patch", id: own, data: { summary: "s" } }, { op: "item.claim", id: own }], 1],
        [[{ op: "item.patch", id: own, data: { summary: "s" } }, { op: "item.archive", id: other, if_version: 1 }], 1],
        [[{ op: "item.patch", id: other, data: { summary: "s" } }], 0],
        [[{ op: "item.patch", id: own, data: { summary: "s" } }, { op: "meta.patch", id: "manager", data: { digest: "x" } }], 1],
        [[{ op: "item.patch", id: own, data: { status: "archived" } }], 0],
        [[{ op: "orchestrator.patch", id: "someone-else", data: { status: "x" } }], 0],
      ];
      for (const [ops, index] of cases) {
        const r = await orch.post("/api/batch", { ops });
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body.index).toBe(index);
      }
      expect((await item(own))!.version).toBe(1);
    });

    it("schedule writes still need an admin or the manager token", async () => {
      const r = await orch.post("/api/batch", { ops: [{ op: "meta.patch", id: "schedule", data: { pickup_interval_min: 5 } }] });
      expect(r.status).toBe(403);
      expect(r.body.index).toBe(0);
    });
  });

  describe("validation", () => {
    const bad = async (body: unknown) => {
      const r = await manager.post("/api/batch", body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      return r.body;
    };

    it("needs a non-empty ops array of at most 50", async () => {
      await bad({});
      await bad({ ops: [] });
      await bad({ ops: "nope" });
      const ops = Array.from({ length: 51 }, () => ({ op: "item.put", id: uid("n"), data: { title: "t" } }));
      expect((await bad({ ops })).message).toMatch(/50/);
      expect(await item(ops[0].id)).toBeNull();
    });

    it("takes 50", async () => {
      const ops = Array.from({ length: 50 }, () => ({ op: "item.put", id: uid("n"), data: { title: "t" } }));
      const r = await manager.post("/api/batch", { ops });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.results).toHaveLength(50);
    });

    it("names the op: unknown ops (decide and deletes included), bad ids, bad bodies", async () => {
      const id = uid("v");
      await createItem(id);
      const ok = { op: "item.patch", id, data: { summary: "s" } };
      expect(await bad({ ops: [ok, { op: "item.decide", id, choice: "a" }] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, { op: "item.delete", id }] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, "x"] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, { op: "item.put", id: "bad id", data: {} }] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, { op: "item.put", id: uid("v"), data: { type: "nope", title: "t" } }] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, { op: "item.patch", id: uid("v") + "x", if_version: -1, data: {} }] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, { op: "meta.patch", id: "lease", data: {} }] })).toMatchObject({ index: 1 });
      expect(await bad({ ops: [ok, { op: "meta.put", id: "people", data: {} }] })).toMatchObject({ index: 1 });
      expect((await item(id))!.version).toBe(1);
    });

    it("refuses two ops on the same doc", async () => {
      const id = uid("v");
      await createItem(id);
      const body = await bad({ ops: [{ op: "item.patch", id, data: { a: 1 } }, { op: "item.archive", id }] });
      expect(body).toMatchObject({ index: 1 });
      expect(body.message).toMatch(/items\/.*twice|once/);
    });
  });

  describe("ntfy", () => {
    let sent: { topic: string; title: string }[] = [];
    beforeEach(() => {
      sent = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      });
    });
    afterEach(() => vi.restoreAllMocks());

    // Through the Worker with NTFY_TOPIC set, waiting for waitUntil work.
    async function batch(ops: unknown[]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request("http://inbox.test/agent/api/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${managerSecret}` },
          body: JSON.stringify({ ops }),
        }),
        { ...env, NTFY_TOPIC: "global-topic" },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return { status: res.status, body: (await res.json()) as any };
    }

    it("pushes once per created ask and per answer, after the commit", async () => {
      const asked = uid("n");
      await createItem(asked, { type: "info", title: "Q" });
      await human.post(`/api/items/${asked}/qa`, { text: "why?" });
      sent = [];
      const r = await batch([
        { op: "item.put", id: uid("n"), data: { type: "proposal", title: "P1" } },
        { op: "item.put", id: uid("n"), data: { type: "blocker", title: "B1" } },
        { op: "item.put", id: uid("n"), data: { type: "info", title: "quiet" } },
        { op: "item.qa", id: asked, text: "because" },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(sent.map((m) => m.title).sort()).toEqual(["Answer: Q", "B1", "P1"]);
    });

    it("pushes nothing when the batch fails", async () => {
      const a = uid("n");
      await createItem(a);
      sent = [];
      const r = await batch([
        { op: "item.put", id: uid("n"), data: { type: "proposal", title: "P1" } },
        { op: "item.patch", id: a, data: { summary: "s" }, if_version: 7 },
      ]);
      expect(r.status).toBe(409);
      expect(r.body.index).toBe(1);
      expect(sent).toEqual([]);
    });
  });
});
