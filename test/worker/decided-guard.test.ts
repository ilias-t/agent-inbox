// docs/api.md "Decided items are kept": a token's PUT or PATCH that would change a decided or processing item's
// status or decision is 409 `decided` (naming who decided, when and the choice), unless the body says
// replace_decided: true. 10-15: a replace 49 s after a decision, pinned on the decided version, wiped it.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

let orch: ReturnType<typeof agent>;
beforeAll(async () => {
  orch = agent((await mintToken("manager", undefined, uid("mgr-guard"))).secret);
});

async function decided(status: "decided" | "processing" = "decided") {
  const id = uid("dg");
  await createItem(id, { options: [{ id: "keep", label: "Keep triggers" }, { id: "drop", label: "Drop them" }] });
  let d = await human.post(`/api/items/${id}/decide`, { choice: "keep", note: "go" });
  expect(d.status).toBe(200);
  if (status === "processing") d = await orch.post(`/api/items/${id}/claim`, { if_version: d.body.version });
  return d.body as { id: string; version: number; data: Record<string, any> };
}

describe("a token can't drop a human's decision by accident", () => {
  it("a replace without the decision is 409 decided, naming who, when and the choice; nothing is written", async () => {
    const doc = await decided();
    const r = await orch.put(`/api/items/${doc.id}`, { data: { type: "decision", title: "New text" }, if_version: doc.version });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("decided");
    expect(r.body.message).toContain("human:you@test");
    expect(r.body.message).toContain(doc.data.decision.decided_at);
    expect(r.body.message).toContain('keep ("Keep triggers")');
    expect(r.body.message).toContain("replace_decided");
    expect(r.body.current).toMatchObject({ id: doc.id, version: doc.version });
    expect((await human.get(`/api/items/${doc.id}`)).body.data.decision.choice).toBe("keep");
  });

  it("so is a patch that reopens it or clears the decision, and the same in a batch (with its index)", async () => {
    const doc = await decided("processing");
    expect((await orch.patch(`/api/items/${doc.id}`, { data: { status: "open" } })).body.error).toBe("decided");
    expect((await orch.patch(`/api/items/${doc.id}`, { data: { decision: null } })).body.error).toBe("decided");
    const b = await orch.post("/api/batch", { ops: [{ op: "item.patch", id: doc.id, data: { decision: null } }] });
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ error: "decided", index: 0 });
  });

  it("an answer whose data would reopen it or clear the decision is refused too", async () => {
    const doc = await decided();
    const r = await orch.post(`/api/items/${doc.id}/qa`, { text: "done", data: { status: "open", decision: null } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("decided");
    expect((await orch.post(`/api/items/${doc.id}/qa`, { text: "fine", data: { summary: "noted" } })).status).toBe(201);
  });

  it("replace_decided: true lets it through; so does a replace or patch that keeps status and decision as they are", async () => {
    const doc = await decided();
    const keep = await orch.put(`/api/items/${doc.id}`, { data: { ...doc.data, summary: "edited" }, if_version: doc.version });
    expect(keep.status).toBe(200);
    expect((await orch.patch(`/api/items/${doc.id}`, { data: { summary: "again" } })).status).toBe(200);
    const meant = await orch.put(`/api/items/${doc.id}`, { data: { type: "decision", title: "Reset" }, replace_decided: true });
    expect(meant.status).toBe(200);
    expect(meant.body.data.decision).toBeUndefined();
  });

  it("the decision resent with its keys in another order is the same decision", async () => {
    const doc = await decided();
    const reordered = Object.fromEntries(Object.entries(doc.data.decision).reverse());
    const r = await orch.put(`/api/items/${doc.id}`, { data: { ...doc.data, decision: reordered, summary: "x" }, if_version: doc.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("replace_decided must be a boolean", async () => {
    const doc = await decided();
    const r = await orch.put(`/api/items/${doc.id}`, { data: { type: "decision", title: "x" }, replace_decided: "yes" });
    expect(r.status).toBe(400);
  });

  it("open and archived items, creates, archive and humans are unaffected", async () => {
    const open = uid("dg");
    await createItem(open);
    expect((await orch.put(`/api/items/${open}`, { data: { type: "decision", title: "Reworded" } })).status).toBe(200);
    const doc = await decided();
    expect((await human.put(`/api/items/${doc.id}`, { data: { type: "decision", title: "Admin replace" } })).status).toBe(200);
    const d2 = await decided();
    expect((await orch.post(`/api/items/${d2.id}/archive`, { if_version: d2.version })).status).toBe(200);
  });
});

void env;
