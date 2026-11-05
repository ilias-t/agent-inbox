import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createItem, human, uid } from "./helpers.ts";

describe("items CRUD", () => {
  it("creates with defaults and stamps, replaces, and reads back", async () => {
    const id = uid("p");
    const created = await human.put(`/api/items/${id}`, { data: { title: "Ship it", extra: { kept: true } } });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.body).toMatchObject({ id, version: 1, updated_by: "human:you@test" });
    expect(created.body.data).toMatchObject({ type: "info", status: "open", title: "Ship it", extra: { kept: true } });
    expect(created.body.data.created_at).toBe(created.body.created_at);
    expect(created.body.data.updated_at).toBe(created.body.created_at);

    const replaced = await human.put(`/api/items/${id}`, { data: { type: "decision", title: "New" }, if_version: 1 });
    expect(replaced.status).toBe(200);
    expect(replaced.body.version).toBe(2);
    expect(replaced.body.data).toMatchObject({ title: "New", status: "open", created_at: created.body.data.created_at });
    expect(replaced.body.data.extra).toBeUndefined();

    const got = await human.get(`/api/items/${id}`);
    expect(got.body).toEqual(replaced.body);
  });

  it("pins writes: stale if_version → 409 with current; if_version 0 means must not exist", async () => {
    const id = uid("pin");
    await createItem(id);
    const stale = await human.put(`/api/items/${id}`, { data: { title: "x" }, if_version: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "conflict", current: { id, version: 1 } });
    const exists = await human.put(`/api/items/${id}`, { data: { title: "x" }, if_version: 0 });
    expect(exists.status).toBe(409);
    const fresh = await human.put(`/api/items/${uid("pin")}`, { data: { title: "x" }, if_version: 0 });
    expect(fresh.status).toBe(201);
    const patchStale = await human.patch(`/api/items/${id}`, { data: { title: "y" }, if_version: 3 });
    expect(patchStale.status).toBe(409);
    expect(patchStale.body.current.data.title).toBe(`Item ${id}`);
  });

  it("PATCH merges shallowly, null deletes, 404 when missing", async () => {
    const id = uid("patch");
    await createItem(id, { summary: "s", priority: "high", links: [{ label: "a", url: "https://a" }] });
    const r = await human.patch(`/api/items/${id}`, { data: { summary: null, context: "c" }, if_version: 1 });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.data.summary).toBeUndefined();
    expect(r.body.data).toMatchObject({ context: "c", priority: "high", title: `Item ${id}` });
    expect((await human.patch(`/api/items/${uid("nope")}`, { data: { title: "x" } })).status).toBe(404);
  });

  it("validates items", async () => {
    const bad = [
      { title: "" },
      { title: "t", type: "nope" },
      { title: "t", status: "done" },
      { title: "t", priority: "urgent" },
      { title: "t", options: [{ label: "no id" }] },
      { title: "t", links: [{ label: "x", url: "javascript:alert(1)" }] },
      { title: "t", evidence: "https://x" },
    ];
    for (const data of bad) {
      const r = await human.put(`/api/items/${uid("v")}`, { data });
      expect(r.status, JSON.stringify(data)).toBe(400);
      expect(r.body.error).toBe("bad_request");
    }
    expect((await human.put(`/api/items/${uid("v")}`, { nodata: 1 })).status).toBe(400);
    expect((await human.patch(`/api/items/${uid("v")}`, { data: { status: null } })).status).toBe(404);
  });

  it("rejects bad ids, bad JSON and oversized bodies", async () => {
    expect((await human.get("/api/items/-bad")).status).toBe(400);
    expect((await human.get("/api/items/has%2Fslash")).status).toBe(400);
    const badJson = await call("PUT", `/api/items/${uid()}`, { body: "{nope" });
    expect(badJson.status).toBe(400);
    const big = await human.put(`/api/items/${uid()}`, { data: { title: "x", blob: "a".repeat(300 * 1024) } });
    expect(big.status).toBe(413);
  });

  it("lists with filters", async () => {
    const o = uid("O");
    await createItem(uid("l"), { orchestrator: o, type: "blocker" });
    const decided = await createItem(uid("l"), { orchestrator: o });
    await human.post(`/api/items/${decided.id}/decide`, { choice: "ack" });
    await human.post(`/api/items/${decided.id}/qa`, { text: "why?" });

    const all = await human.get(`/api/items?orchestrator=${o}`);
    expect(all.body.items).toHaveLength(2);
    expect((await human.get(`/api/items?orchestrator=${o}&status=decided`)).body.items.map((d: any) => d.id)).toEqual([
      decided.id,
    ]);
    expect((await human.get(`/api/items?orchestrator=${o}&status=open,decided`)).body.items).toHaveLength(2);
    expect((await human.get(`/api/items?orchestrator=${o}&type=blocker`)).body.items).toHaveLength(1);
    expect((await human.get(`/api/items?orchestrator=${o}&qa_pending=true`)).body.items).toHaveLength(1);
    expect((await human.get(`/api/items?orchestrator=${o}&qa_pending=false`)).body.items).toHaveLength(1);
    expect((await human.get("/api/items?status=bogus")).status).toBe(400);
  });

  it("DELETE removes the item and its qa; a stale pin keeps both", async () => {
    const id = uid("del");
    await createItem(id);
    await human.post(`/api/items/${id}/qa`, { text: "q" }); // item now v2
    const stale = await human.del(`/api/items/${id}?if_version=1`);
    expect(stale.status).toBe(409);
    expect(stale.body.current.version).toBe(2);
    expect((await human.get(`/api/items/${id}/qa`)).body.messages).toHaveLength(1);

    expect((await human.del(`/api/items/${id}?if_version=2`)).body).toEqual({ ok: true });
    expect((await human.get(`/api/items/${id}`)).status).toBe(404);
    const qa = await env.DB.prepare("SELECT count(*) AS n FROM docs WHERE collection = ?").bind(`items/${id}/qa`).first();
    expect(qa?.n).toBe(0);
    expect((await human.del(`/api/items/${id}`)).status).toBe(404);
  });
});

describe("decide / claim / archive", () => {
  it("decides an open item and refuses a second decide with not_open", async () => {
    const id = uid("d");
    await createItem(id, { type: "proposal" });
    const r = await human.post(`/api/items/${id}/decide`, { choice: "approve", note: "go" });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("decided");
    expect(r.body.data.decision).toMatchObject({ choice: "approve", note: "go", by: "human:you@test" });
    expect(r.body.data.decision.decided_at).toBe(r.body.updated_at);
    const again = await human.post(`/api/items/${id}/decide`, { choice: "reject" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "not_open", current: { id, version: 2 } });
  });

  it("if_version binds the decision to the version the human saw: a changed item is 409 conflict, not decided", async () => {
    const id = uid("d");
    const seen = await createItem(id, { type: "proposal", title: "Rename a variable" });
    await human.patch(`/api/items/${id}`, { data: { title: "Drop the prod database" } });
    const r = await human.post(`/api/items/${id}/decide`, { choice: "approve", if_version: seen.version });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "conflict", current: { id, version: 2, data: { title: "Drop the prod database" } } });
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
    const ok = await human.post(`/api/items/${id}/decide`, { choice: "reject", if_version: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.decision.choice).toBe("reject");
  });

  it("a pinned decide on an item that is no longer open is not_open; without a pin it decides the latest", async () => {
    const id = uid("d");
    await createItem(id);
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    const r = await human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_open", current: { version: 2 } });
    expect((await human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: -1 })).status).toBe(400);
    const other = uid("d");
    await createItem(other);
    await human.patch(`/api/items/${other}`, { data: { summary: "changed" } });
    expect((await human.post(`/api/items/${other}/decide`, { choice: "ack" })).status).toBe(200);
  });

  it("other needs a note", async () => {
    const id = uid("d");
    await createItem(id);
    expect((await human.post(`/api/items/${id}/decide`, { choice: "other" })).status).toBe(400);
    expect((await human.post(`/api/items/${id}/decide`, { choice: "other", note: " " })).status).toBe(400);
    const ok = await human.post(`/api/items/${id}/decide`, { choice: "other", note: "do X instead" });
    expect(ok.body.data.decision).toMatchObject({ choice: "other", note: "do X instead" });
    expect((await human.post(`/api/items/${uid()}/decide`, { choice: "ack" })).status).toBe(404);
  });

  describe("choice must be one the page offers", () => {
    const decide = (id: string, choice: string, note?: string) => human.post(`/api/items/${id}/decide`, { choice, note });

    it("explicit options: one of their ids or other; anything else is 400 listing the valid choices", async () => {
      const id = uid("ch");
      await createItem(id, { options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }] });
      for (const choice of ["approve", "ack", "PG"]) {
        const r = await decide(id, choice);
        expect(r.status, choice).toBe(400);
        expect(r.body).toMatchObject({ error: "bad_request", message: expect.stringContaining("pg, sqlite, other") });
      }
      expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
      const ok = await decide(id, "sqlite");
      expect(ok.status).toBe(200);
      expect(ok.body.data.decision.choice).toBe("sqlite");
    });

    it("a proposal without options takes approve or reject, not ack", async () => {
      const id = uid("ch");
      await createItem(id, { type: "proposal" });
      const r = await decide(id, "ack");
      expect(r.status).toBe(400);
      expect(r.body.message).toContain("approve, reject, other");
      expect((await decide(id, "reject")).status).toBe(200);
    });

    it("other types without options take ack, not approve", async () => {
      for (const type of ["decision", "blocker", "info", "pr_ready"] as const) {
        const id = uid("ch");
        await createItem(id, { type });
        expect((await decide(id, "approve")).status, type).toBe(400);
        expect((await decide(id, "ack")).status, type).toBe(200);
      }
    });

    it("an empty options array falls back to the type's defaults", async () => {
      const id = uid("ch");
      await createItem(id, { type: "proposal", options: [] });
      expect((await decide(id, "approve")).status).toBe(200);
    });

    it("a stale pin is still 409 conflict, whatever the choice", async () => {
      const id = uid("ch");
      await createItem(id);
      await human.patch(`/api/items/${id}`, { data: { summary: "changed" } });
      const r = await human.post(`/api/items/${id}/decide`, { choice: "nope", if_version: 1 });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("conflict");
    });
  });

  it("auto_decided: accept archives and keeps the agent's decision", async () => {
    const id = uid("auto");
    const decision = { choice: "b", note: "picked b", decided_at: "2026-10-01T00:00:00.000Z" };
    await createItem(id, { type: "auto_decided", decision });
    const r = await human.post(`/api/items/${id}/decide`, { choice: "accept" });
    expect(r.body.data).toMatchObject({ status: "archived", decision });
  });

  it("auto_decided: override needs a note and records override_of", async () => {
    const id = uid("auto");
    await createItem(id, { type: "auto_decided", decision: { choice: "b", decided_at: "2026-10-01T00:00:00.000Z" } });
    expect((await human.post(`/api/items/${id}/decide`, { choice: "override" })).status).toBe(400);
    expect((await human.post(`/api/items/${id}/decide`, { choice: "approve" })).status).toBe(400);
    const r = await human.post(`/api/items/${id}/decide`, { choice: "override", note: "use a" });
    expect(r.body.data).toMatchObject({
      status: "decided",
      override_of: "b",
      decision: { choice: "override", note: "use a", by: "human:you@test" },
    });
  });

  it("claim moves decided → processing, else not_decided; pins conflict", async () => {
    const id = uid("c");
    await createItem(id);
    const notYet = await human.post(`/api/items/${id}/claim`, {});
    expect(notYet.status).toBe(409);
    expect(notYet.body).toMatchObject({ error: "not_decided", current: { version: 1 } });
    await human.post(`/api/items/${id}/decide`, { choice: "ack" }); // v2
    const stale = await human.post(`/api/items/${id}/claim`, { if_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("conflict");
    const ok = await human.post(`/api/items/${id}/claim`, { if_version: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("processing");
    const twice = await human.post(`/api/items/${id}/claim`);
    expect(twice.body.error).toBe("not_decided");
  });

  it("archive works from any status, with an optional pin", async () => {
    const id = uid("a");
    await createItem(id);
    expect((await human.post(`/api/items/${id}/archive`, { if_version: 5 })).status).toBe(409);
    const r = await human.post(`/api/items/${id}/archive`);
    expect(r.body.data.status).toBe("archived");
    expect((await human.post(`/api/items/${id}/archive`)).body.version).toBe(3);
  });
});
