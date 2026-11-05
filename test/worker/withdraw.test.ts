// POST /api/items/:id/withdraw: the asker takes back an open question that no
// longer applies (docs/api.md "Withdrawing your own item"). The item is
// archived with decision {choice: "withdrawn", note?, decided_at, by}.
import { beforeAll, describe, expect, it } from "vitest";
import { agent, createItem, human, mintToken, person, setRoles, uid } from "./helpers.ts";

const O = "O-wd";
let orch: ReturnType<typeof agent>;
let manager: ReturnType<typeof agent>;
const decider = person("decider@wd.test");
const viewer = person("viewer@wd.test");

beforeAll(async () => {
  orch = agent((await mintToken("orchestrator", O, "wd-token")).secret);
  manager = agent((await mintToken("manager", undefined, "wd-manager")).secret);
  await setRoles({ "you@test": "admin", "decider@wd.test": "decider", "viewer@wd.test": "viewer" });
});

// An open item the token posted itself, with source = its id.
const own = async (data: Record<string, unknown> = {}) => {
  const id = uid("wd");
  const doc = await createItem(id, { orchestrator: O, source: O, ...data });
  return { id, version: doc.version };
};
const get = async (id: string) => (await human.get(`/api/items/${id}`)).body;

describe("orchestrator token: withdrawing its own open item", () => {
  it("archives it with a withdrawn decision, pinned on the version read", async () => {
    const { id, version } = await own();
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: version, note: "Hold cleared on GitHub" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id, version: version + 1, updated_by: "token:wd-token" });
    expect(r.body.data.status).toBe("archived");
    expect(r.body.data.decision).toEqual({
      choice: "withdrawn",
      ended: "withdrawn",
      note: "Hold cleared on GitHub",
      decided_at: r.body.updated_at,
      by: "token:wd-token",
    });
  });

  it("stores no note key when none is given", async () => {
    const { id, version } = await own();
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: version });
    expect(r.status).toBe(200);
    expect(r.body.data.decision).toEqual({ choice: "withdrawn", ended: "withdrawn", decided_at: r.body.updated_at, by: "token:wd-token" });
  });

  it("needs if_version", async () => {
    const { id } = await own();
    const r = await orch.post(`/api/items/${id}/withdraw`, {});
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/if_version/);
    expect((await get(id)).data.status).toBe("open");
  });

  it("a stale pin is 409 conflict and withdraws nothing", async () => {
    const { id, version } = await own();
    await orch.patch(`/api/items/${id}`, { data: { summary: "edited" } });
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: version });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "conflict", current: { version: version + 1 } });
    expect((await get(id)).data.status).toBe("open");
  });

  it("another orchestrator's item is 403", async () => {
    const id = uid("wd-other");
    await createItem(id, { orchestrator: "O-elsewhere", source: O });
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: 1 });
    expect(r.status).toBe(403);
    expect((await get(id)).data.status).toBe("open");
  });

  it.each([
    ["no source", { source: undefined }],
    ["another source", { source: "O-elsewhere" }],
    ["a manager-written source", { source: "sweep:O-wd" }],
  ])("its own item with %s is 403: it isn't the agent's question to take back", async (_, data) => {
    const { id, version } = await own(data);
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: version });
    expect(r.status).toBe(403);
    expect((await get(id)).data.status).toBe("open");
  });

  // Ownership is the source the item was posted with: a token can't take it
  // over by rewriting source while the item is open, then withdraw it.
  it("can't claim a manager's item by patching its source, then withdraw it", async () => {
    const id = uid("wd-sweep");
    const doc = await createItem(id, { orchestrator: O, source: "sweep:O-wd" });
    const p = await orch.patch(`/api/items/${id}`, { data: { source: O } });
    expect(p.status).toBe(403);
    expect(p.body.message).toMatch(/source/);
    const w = await orch.post(`/api/items/${id}/withdraw`, { if_version: doc.version });
    expect(w.status).toBe(403);
    expect((await get(id)).data).toMatchObject({ status: "open", source: "sweep:O-wd" });
  });

  it.each([
    ["a replace that changes it", (data: Record<string, unknown>) => ({ ...data, source: O })],
    ["a patch that adds it", () => ({ source: O })],
  ])("source is fixed once posted: %s is 403", async (label, body) => {
    const id = uid("wd-src");
    const { data } = await createItem(id, { orchestrator: O, ...(label.includes("adds") ? {} : { source: "sweep:O-wd" }) });
    const r = label.includes("replace")
      ? await orch.put(`/api/items/${id}`, { data: body(data as Record<string, unknown>) })
      : await orch.patch(`/api/items/${id}`, { data: body(data as Record<string, unknown>) });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/source/);
  });

  it("source may stay as posted, or be dropped (which only gives up the right to withdraw)", async () => {
    const { id } = await own();
    expect((await orch.patch(`/api/items/${id}`, { data: { summary: "s", source: O } })).status).toBe(200);
    const { data } = await get(id);
    const { source: _, ...rest } = data;
    expect((await orch.put(`/api/items/${id}`, { data: rest })).status).toBe(200);
    expect((await get(id)).data.source).toBeUndefined();
  });

  it("an admin or the manager may still change source", async () => {
    const id = uid("wd-src-full");
    await createItem(id, { orchestrator: O, source: "sweep:O-wd" });
    expect((await manager.patch(`/api/items/${id}`, { data: { source: O } })).status).toBe(200);
    expect((await human.patch(`/api/items/${id}`, { data: { source: "manager" } })).status).toBe(200);
  });

  it.each(["manager", "scout:x", "sweep:O3"])("a token whose id is a manager source (%s) can't withdraw", async (o) => {
    const t = agent((await mintToken("orchestrator", o)).secret);
    const id = uid("wd-mgr-src");
    await createItem(id, { orchestrator: o, source: o });
    expect((await t.post(`/api/items/${id}/withdraw`, { if_version: 1 })).status).toBe(403);
  });

  it.each(["decided", "processing", "archived"])("a %s item is 409 not_open: the human already answered", async (status) => {
    const { id } = await own();
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    if (status === "processing") await manager.post(`/api/items/${id}/claim`);
    if (status === "archived") await human.post(`/api/items/${id}/archive`);
    const cur = await get(id);
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: cur.version });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_open", current: { id, version: cur.version, data: { status } } });
    expect((await get(id)).data.decision.choice).toBe("ack");
  });

  it("an auto_decided item is 400: it carries the agent's own decision, not a question", async () => {
    const id = uid("wd-auto");
    await orch.put(`/api/items/${id}`, {
      data: { type: "auto_decided", title: "picked", orchestrator: O, source: O, decision: { choice: "a", decided_at: "2026-10-07T00:00:00Z" } },
    });
    const r = await orch.post(`/api/items/${id}/withdraw`, { if_version: 1 });
    expect(r.status).toBe(400);
    expect((await get(id)).data).toMatchObject({ status: "open", decision: { choice: "a" } });
  });

  it("an unknown item is 404 unpinned, and 409 conflict pinned (as archive: the pin is checked first)", async () => {
    const r = await manager.post(`/api/items/${uid("wd-none")}/withdraw`, {});
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/^No item /);
    expect((await orch.post(`/api/items/${uid("wd-none")}/withdraw`, { if_version: 1 })).body).toMatchObject({ error: "conflict", current: null });
  });

  it("a note over 8000 characters is 400", async () => {
    const { id, version } = await own();
    expect((await orch.post(`/api/items/${id}/withdraw`, { if_version: version, note: "x".repeat(8001) })).status).toBe(400);
  });

  it("once withdrawn, a human's decide is 409 not_open", async () => {
    const { id, version } = await own();
    await orch.post(`/api/items/${id}/withdraw`, { if_version: version });
    const r = await human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: version });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_open");
    expect((await get(id)).data.decision.choice).toBe("withdrawn");
  });
});

// The runner withdraws on its prefetched version while the human may be
// deciding the same version on the phone: of the two, exactly one lands.
describe("racing a human decide on the same version", () => {
  it.each([0, 1, 2, 3, 4])("exactly one lands, the other is 409 (round %i)", async () => {
    const { id, version } = await own();
    const [decide, withdraw] = await Promise.all([
      human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: version }),
      orch.post(`/api/items/${id}/withdraw`, { if_version: version, note: "gone" }),
    ]);
    expect([decide.status, withdraw.status].sort()).toEqual([200, 409]);
    const loser = decide.status === 409 ? decide : withdraw;
    expect(["conflict", "not_open"]).toContain(loser.body.error);
    const final = await get(id);
    expect(final.version).toBe(version + 1);
    expect(final.data.decision.choice).toBe(decide.status === 200 ? "ack" : "withdrawn");
    expect(final.data.status).toBe(decide.status === 200 ? "decided" : "archived");
  });
});

describe("full callers: manager and admin humans", () => {
  it("the manager withdraws any open item, without a pin", async () => {
    const id = uid("wd-any");
    await createItem(id, { orchestrator: "O-elsewhere" });
    const r = await manager.post(`/api/items/${id}/withdraw`, { note: "superseded" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: "archived", decision: { choice: "withdrawn", note: "superseded", by: "token:wd-manager" } });
  });

  it("an admin human withdraws any open item", async () => {
    const id = uid("wd-admin");
    await createItem(id);
    const r = await human.post(`/api/items/${id}/withdraw`, { if_version: 1 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "archived", decision: { choice: "withdrawn", by: "human:you@test" } });
  });

  it("still only an open one: a decided item is 409 not_open for the manager too", async () => {
    const id = uid("wd-mgr-dec");
    await createItem(id);
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    const r = await manager.post(`/api/items/${id}/withdraw`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_open");
  });

  it.each([
    ["decider", decider],
    ["viewer", viewer],
  ])("a %s is 403", async (_, who) => {
    const id = uid("wd-role");
    await createItem(id);
    expect((await who.post(`/api/items/${id}/withdraw`, { if_version: 1 })).status).toBe(403);
    expect((await get(id)).data.status).toBe("open");
  });
});

describe("batch item.withdraw", () => {
  it("an orchestrator token batches withdraws with its other writes", async () => {
    const a = await own(), b = await own(), fresh = uid("wd-new");
    const r = await orch.post("/api/batch", {
      ops: [
        { op: "item.withdraw", id: a.id, if_version: a.version, note: "Hold cleared on GitHub" },
        { op: "item.withdraw", id: b.id, if_version: b.version },
        { op: "item.put", id: fresh, if_version: 0, data: { type: "decision", title: "new ask", orchestrator: O, source: O } },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results[0]).toMatchObject({ id: a.id, data: { status: "archived", decision: { choice: "withdrawn", note: "Hold cleared on GitHub" } } });
    expect(r.body.results[1]).toMatchObject({ id: b.id, data: { status: "archived", decision: { choice: "withdrawn" } } });
    expect(r.body.results[2]).toMatchObject({ id: fresh, data: { status: "open" } });
  });

  it("is held to the route's rules: a decided item fails the whole batch with its index", async () => {
    const open = await own(), decided = await own();
    const d = await human.post(`/api/items/${decided.id}/decide`, { choice: "ack" });
    const r = await orch.post("/api/batch", {
      ops: [
        { op: "item.withdraw", id: open.id, if_version: open.version },
        { op: "item.withdraw", id: decided.id, if_version: d.body.version },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_open", index: 1 });
    expect((await get(open.id)).data.status).toBe("open");
  });

  it("needs if_version per op for an orchestrator token", async () => {
    const a = await own();
    const r = await orch.post("/api/batch", { ops: [{ op: "item.withdraw", id: a.id }] });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ index: 0, message: expect.stringMatching(/if_version/) });
  });
});
