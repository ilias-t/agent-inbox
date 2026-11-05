import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { landedClause, mutate } from "../../worker/store.ts";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

let manager: ReturnType<typeof agent>;
beforeAll(async () => {
  manager = agent((await mintToken("manager", undefined, "manager-x")).secret);
});

const qaCount = async (id: string) =>
  (await env.DB.prepare("SELECT count(*) AS n FROM docs WHERE collection = ?").bind(`items/${id}/qa`).first())?.n;

describe("qa threads", () => {
  it("a user question sets qa_pending without touching status", async () => {
    const id = uid("q");
    await createItem(id);
    const r = await human.post(`/api/items/${id}/qa`, { text: "What does B cost?" });
    expect(r.status).toBe(201);
    expect(r.body.message.id).toMatch(/^m-\d+-[0-9a-z]{4}$/);
    expect(r.body.message).toMatchObject({ version: 1, updated_by: "human:you@test" });
    expect(r.body.message.data).toMatchObject({ role: "user", text: "What does B cost?", by: "human:you@test" });
    expect(r.body.item.data).toMatchObject({ status: "open", qa_pending: true, qa_last_at: r.body.message.created_at });
    expect(r.body.item.version).toBe(2);
  });

  it("a manager answer clears qa_pending, merges data, and lists oldest first", async () => {
    const id = uid("q");
    await createItem(id);
    await human.post(`/api/items/${id}/qa`, { text: "q1" });
    const a = await manager.post(`/api/items/${id}/qa`, {
      text: "a1",
      if_version: 2,
      data: { recommendation: { option: "b", why: "cheaper" } },
    });
    expect(a.status).toBe(201);
    expect(a.body.message.data).toMatchObject({ role: "manager", by: "token:manager-x" });
    expect(a.body.item.data).toMatchObject({ qa_pending: false, recommendation: { option: "b" } });
    expect(a.body.item.data.qa_answered_at).toBe(a.body.message.created_at);
    const list = await human.get(`/api/items/${id}/qa`);
    expect(list.body.messages.map((m: any) => m.data.text)).toEqual(["q1", "a1"]);
  });

  it("a pinned answer that loses stores no message", async () => {
    const id = uid("q");
    await createItem(id);
    await human.post(`/api/items/${id}/qa`, { text: "q1" }); // v2
    await human.post(`/api/items/${id}/qa`, { text: "q2" }); // v3: the user asked again mid-tick
    const r = await manager.post(`/api/items/${id}/qa`, { text: "answer to q1", if_version: 2 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "conflict", current: { version: 3, data: { qa_pending: true } } });
    expect(await qaCount(id)).toBe(2);
  });

  it("the guarded insert stores nothing when the item write misses inside the batch", async () => {
    // Deterministic race: another write by the same actor in the same
    // millisecond lands between mutate's read and its pinned UPDATE, so the
    // batch's UPDATE matches 0 rows while the row looks exactly like its own.
    const id = uid("q");
    await createItem(id);
    const now = new Date().toISOString();
    const insertMsg = (version: number) =>
      env.DB.prepare(
        `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by)
         SELECT ?, 'm-race', '{}', 1, ?, ?, 'test' WHERE ${landedClause}`,
      ).bind(`items/${id}/qa`, now, now, "items", id, version, now, "test");
    const opts = (ifVersion: number) => ({
      actor: "test",
      now,
      ifVersion,
      extra: ({ version }: { version: number }) => [insertMsg(version)],
    });
    const attempt = mutate<Record<string, unknown>>(env.DB, "items", id, opts(1), async (cur) => {
      await env.DB.prepare(
        "UPDATE docs SET version = version + 1, updated_at = ?, updated_by = 'test' WHERE collection = 'items' AND id = ?",
      )
        .bind(now, id)
        .run();
      return cur!.data;
    });
    await expect(attempt).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(await qaCount(id)).toBe(0);

    // The same statements with nothing interfering: both land.
    const ok = await mutate<Record<string, unknown>>(env.DB, "items", id, opts(2), (cur) => cur!.data);
    expect(ok.doc.version).toBe(3);
    expect(await qaCount(id)).toBe(1);
  });

  it("concurrent unpinned answers both land, one message each", async () => {
    const id = uid("q");
    await createItem(id);
    const [a, b] = await Promise.all([
      manager.post(`/api/items/${id}/qa`, { text: "a" }),
      manager.post(`/api/items/${id}/qa`, { text: "b" }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await qaCount(id)).toBe(2);
    expect((await human.get(`/api/items/${id}`)).body.version).toBe(3);
  });

  it("enforces roles, text bounds and data only on answers", async () => {
    const id = uid("q");
    await createItem(id);
    expect((await human.post(`/api/items/${id}/qa`, { text: "x", role: "manager" })).status).toBe(403);
    expect((await manager.post(`/api/items/${id}/qa`, { text: "x", role: "user" })).status).toBe(403);
    expect((await human.post(`/api/items/${id}/qa`, { text: "" })).status).toBe(400);
    expect((await human.post(`/api/items/${id}/qa`, { text: "a".repeat(8001) })).status).toBe(400);
    expect((await human.post(`/api/items/${id}/qa`, { text: "x", data: { title: "t" } })).status).toBe(400);
    expect((await human.post(`/api/items/${uid()}/qa`, { text: "x" })).status).toBe(404);
    expect((await human.get(`/api/items/${uid()}/qa`)).status).toBe(404);
  });

  it("orchestrator answers are labelled orchestrator", async () => {
    const o = uid("O");
    const orch = agent((await mintToken("orchestrator", o, `orchestrator-${o}`)).secret);
    const id = uid("q");
    await createItem(id, { orchestrator: o });
    const r = await orch.post(`/api/items/${id}/qa`, { text: "here's why" });
    expect(r.status).toBe(201);
    expect(r.body.message.data).toMatchObject({ role: "orchestrator", by: `token:orchestrator-${o}` });
    expect(r.body.item.data.qa_pending).toBe(false);
  });
});
