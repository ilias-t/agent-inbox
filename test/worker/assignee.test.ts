// Item assignee: validation, the ?assignee= filter and who may set it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

describe("assignee field", () => {
  it("is optional, kept trimmed and lowercased, and an email without a dot is fine", async () => {
    const plain = await createItem(uid("as"));
    expect(plain.data.assignee).toBeUndefined();
    const id = uid("as");
    const r = await human.put(`/api/items/${id}`, { data: { title: "t", assignee: "  Alice@Example.com " } });
    expect(r.status).toBe(201);
    expect(r.body.data.assignee).toBe("alice@example.com");
    const dev = await human.put(`/api/items/${uid("as")}`, { data: { title: "t", assignee: "dev@localhost" } });
    expect(dev.body.data.assignee).toBe("dev@localhost");
  });

  it("rejects values that aren't an email", async () => {
    for (const assignee of ["", "alice", "a b@x", "@x", "x@", 42, ["a@x"], `${"a".repeat(250)}@x.com`]) {
      const r = await human.put(`/api/items/${uid("as")}`, { data: { title: "t", assignee } });
      expect(r.status, JSON.stringify(assignee)).toBe(400);
      expect(r.body.error).toBe("bad_request");
    }
  });

  it("PATCH reassigns and null unassigns; PUT with null stores no key", async () => {
    const id = uid("as");
    await createItem(id, { assignee: "alice@example.com" });
    const re = await human.patch(`/api/items/${id}`, { data: { assignee: "bob@example.com" }, if_version: 1 });
    expect(re.status).toBe(200);
    expect(re.body.data.assignee).toBe("bob@example.com");
    const un = await human.patch(`/api/items/${id}`, { data: { assignee: null }, if_version: 2 });
    expect(un.body.data).not.toHaveProperty("assignee");
    const put = await human.put(`/api/items/${uid("as")}`, { data: { title: "t", assignee: null } });
    expect(put.status).toBe(201);
    expect(put.body.data).not.toHaveProperty("assignee");
  });

  it("a stored legacy non-email assignee doesn't block writes that leave it alone", async () => {
    const id = uid("legacy");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by)
       VALUES ('items', ?1, ?2, 1, ?3, ?3, 'import:artifact')`,
    )
      .bind(id, JSON.stringify({ type: "decision", title: "old", status: "open", assignee: "Alice" }), now)
      .run();
    const patch = await human.patch(`/api/items/${id}`, { data: { summary: "s" } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.assignee).toBe("Alice");
    const replace = await human.put(`/api/items/${id}`, { data: { title: "new", assignee: "Alice" } });
    expect(replace.status).toBe(200);
    expect(replace.body.data.assignee).toBe("Alice");
    expect((await human.post(`/api/items/${id}/qa`, { text: "why?" })).status).toBe(201);
    expect((await human.patch(`/api/items/${id}`, { data: { assignee: "Bob" } })).status).toBe(400);
    expect((await human.patch(`/api/items/${id}`, { data: { assignee: "bob@example.com" } })).body.data.assignee).toBe("bob@example.com");
  });

  it("an orchestrator token may set and change it on its own items", async () => {
    const o = uid("O");
    const orch = agent((await mintToken("orchestrator", o)).secret);
    const id = uid("as");
    const c = await orch.put(`/api/items/${id}`, { data: { title: "t", orchestrator: o, assignee: "alice@example.com" } });
    expect(c.status).toBe(201);
    const p = await orch.patch(`/api/items/${id}`, { data: { assignee: "bob@example.com" } });
    expect(p.status).toBe(200);
    expect(p.body.data.assignee).toBe("bob@example.com");
  });
});

describe("?assignee= filter", () => {
  it("matches an email (any case), or none for unassigned", async () => {
    const o = uid("O");
    const a = await createItem(uid("f"), { orchestrator: o, assignee: "alice@example.com" });
    const b = await createItem(uid("f"), { orchestrator: o, assignee: "bob@example.com" });
    const n = await createItem(uid("f"), { orchestrator: o });
    const ids = async (q: string) => (await human.get(`/api/items?orchestrator=${o}&${q}`)).body.items.map((d: any) => d.id);
    expect(await ids("assignee=alice@example.com")).toEqual([a.id]);
    expect(await ids("assignee=ALICE%40example.com")).toEqual([a.id]);
    expect(await ids("assignee=none")).toEqual([n.id]);
    expect(await ids("assignee=bob@example.com&status=open")).toEqual([b.id]);
    expect((await human.get("/api/items?assignee=nobody")).status).toBe(400);
  });
});
