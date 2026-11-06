// The orchestrator-token scope matrix from docs/api.md "Principals and scopes".
import { beforeAll, describe, expect, it } from "vitest";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

const O = "O3";
let orch: ReturnType<typeof agent>;
let manager: ReturnType<typeof agent>;
let mine: string;
let theirs: string;

beforeAll(async () => {
  orch = agent((await mintToken("orchestrator", O, "o3-token")).secret);
  manager = agent((await mintToken("manager")).secret);
  mine = uid("O3-item");
  theirs = uid("O4-item");
  await createItem(mine, { orchestrator: O });
  await createItem(theirs, { orchestrator: "O4" });
  await human.put(`/api/orchestrators/${O}`, { data: { goal: "g" } });
  await human.put("/api/orchestrators/O4", { data: { goal: "g4" } });
});

describe("orchestrator token: allowed", () => {
  it("reads its own items, qa, orchestrator doc, schedule, changes and me", async () => {
    const list = await orch.get("/api/items");
    expect(list.status).toBe(200);
    expect(list.body.items.every((d: any) => d.data.orchestrator === O)).toBe(true);
    expect(list.body.items.some((d: any) => d.id === mine)).toBe(true);
    // The orchestrator filter is forced, whatever the query says.
    expect((await orch.get("/api/items?orchestrator=O4")).body.items.every((d: any) => d.data.orchestrator === O)).toBe(true);
    expect((await orch.get(`/api/items/${mine}`)).status).toBe(200);
    expect((await orch.get(`/api/items/${mine}/qa`)).status).toBe(200);
    expect((await orch.get(`/api/orchestrators/${O}`)).status).toBe(200);
    expect((await orch.get("/api/schedule")).status).toBe(200);
    expect((await orch.get("/api/changes")).status).toBe(200);
    expect((await orch.get("/api/me")).body).toEqual({ kind: "token", name: "o3-token", scope: "orchestrator", orchestrator: O, fleet: "default" });
  });

  it("creates and patches its own open items, and auto_decided with a decision", async () => {
    const id = uid("O3-new");
    const c = await orch.put(`/api/items/${id}`, { data: { type: "blocker", title: "stuck", orchestrator: O } });
    expect(c.status).toBe(201);
    expect(c.body.updated_by).toBe("token:o3-token");
    expect((await orch.patch(`/api/items/${id}`, { data: { summary: "more" } })).status).toBe(200);
    expect((await orch.patch(`/api/items/${id}`, { data: { status: "open" } })).status).toBe(200);
    const auto = await orch.put(`/api/items/${uid("O3-auto")}`, {
      data: { type: "auto_decided", title: "picked", orchestrator: O, decision: { choice: "a", decided_at: "2026-10-07T00:00:00Z" } },
    });
    expect(auto.status).toBe(201);
  });

  it("on a decided item, changes only what doesn't alter what was decided: assignee, pr_state, qa", async () => {
    const id = uid("O3-dec");
    await createItem(id, { orchestrator: O, source: O }); // pr_state is a closure field: its own items only
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    const r = await orch.patch(`/api/items/${id}`, { data: { assignee: "alice@example.com", pr_state: "open" } });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("decided");
    expect((await orch.post(`/api/items/${id}/qa`, { text: "on it" })).status).toBe(201);
    // A replace that carries the content verbatim is fine too.
    const { data } = (await human.get(`/api/items/${id}`)).body;
    expect((await orch.put(`/api/items/${id}`, { data: { ...data, assignee: null } })).status).toBe(200);
  });

  it("creates its own orchestrator doc (create only, id forced)", async () => {
    const own = uid("O9");
    const o9 = agent((await mintToken("orchestrator", own)).secret);
    const c = await o9.put(`/api/orchestrators/${own}`, { data: { id: "spoof", goal: "g" } });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ id: own, goal: "g" });
    expect((await o9.put(`/api/orchestrators/${own}`, { data: { goal: "again" } })).status).toBe(403);
    expect((await o9.put(`/api/orchestrators/${own}`, { data: { goal: "again" }, if_version: 1 })).status).toBe(403);
    expect((await o9.put(`/api/orchestrators/${uid("O10")}`, { data: {} })).status).toBe(403);
    expect((await o9.patch(`/api/orchestrators/${own}`, { data: { headline: "h" } })).status).toBe(200);
  });

  it("answers on its own items and patches its own orchestrator doc", async () => {
    expect((await orch.post(`/api/items/${mine}/qa`, { text: "answer" })).status).toBe(201);
    const p = await orch.patch(`/api/orchestrators/${O}`, { data: { headline: "on it" } });
    expect(p.status).toBe(200);
    expect(p.body.data.headline).toBe("on it");
  });

  it("/api/state returns only its own items and orchestrator", async () => {
    const s = await orch.get("/api/state");
    expect(s.status).toBe(200);
    expect(s.body.items.every((d: any) => d.data.orchestrator === O)).toBe(true);
    expect(s.body.orchestrators.map((d: any) => d.id)).toEqual([O]);
    expect(s.body.manager).toBeNull();
    expect(s.body.lease).toBeNull();
  });
});

// A standalone agent archives its own item once it has read the decision.
// Only `decided` items it posted with `source` = its id, pinned: the manager
// claims (decided → processing, pinned) only items from its registry, and of
// a claim and an archive on the same version exactly one lands.
describe("orchestrator token: archiving its own decided item", () => {
  const decided = async (data: Record<string, unknown> = { source: O }) => {
    const id = uid("O3-arch");
    await createItem(id, { orchestrator: O, ...data });
    const d = await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    expect(d.status).toBe(200);
    return { id, version: d.body.version as number };
  };

  it("archives it when it is decided, pinned on the version read", async () => {
    const { id, version } = await decided();
    const r = await orch.post(`/api/items/${id}/archive`, { if_version: version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ version: version + 1, updated_by: "token:o3-token", data: { status: "archived" } });
    expect(r.body.data.decision.choice).toBe("ack");
  });

  it("needs if_version", async () => {
    const { id } = await decided();
    const r = await orch.post(`/api/items/${id}/archive`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/if_version/);
  });

  it("a stale pin is 409 conflict", async () => {
    const { id, version } = await decided();
    const r = await orch.post(`/api/items/${id}/archive`, { if_version: version - 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("conflict");
  });

  it("an open item is 409 not_decided: archiving doesn't skip the human", async () => {
    const id = uid("O3-arch");
    await createItem(id, { orchestrator: O, source: O });
    const r = await orch.post(`/api/items/${id}/archive`, { if_version: 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_decided", current: { id, version: 1 } });
  });

  it("an item the manager claimed (processing) is 409 not_decided: the manager archives it", async () => {
    const { id, version } = await decided();
    await manager.post(`/api/items/${id}/claim`, { if_version: version });
    const r = await orch.post(`/api/items/${id}/archive`, { if_version: version + 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_decided", current: { data: { status: "processing" } } });
  });

  it("racing a manager claim on the same version, exactly one lands", async () => {
    const { id, version } = await decided();
    const [claim, archive] = await Promise.all([
      manager.post(`/api/items/${id}/claim`, { if_version: version }),
      orch.post(`/api/items/${id}/archive`, { if_version: version }),
    ]);
    expect([claim.status, archive.status].sort()).toEqual([200, 409]);
    expect((await human.get(`/api/items/${id}`)).body.version).toBe(version + 1);
  });

  it.each([
    ["no source", {}],
    ["another source", { source: "O4" }],
    ["a manager-written source", { source: "sweep:O3" }],
  ])("an item with %s is 403: it isn't the agent's to close", async (_, data) => {
    const { id, version } = await decided(data);
    const r = await orch.post(`/api/items/${id}/archive`, { if_version: version });
    expect(r.status).toBe(403);
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("decided");
  });

  it.each(["manager", "scout:x", "sweep:O3"])("a token whose id is a manager source (%s) can't archive", async (o) => {
    const t = agent((await mintToken("orchestrator", o)).secret);
    const id = uid("mgr-src");
    await createItem(id, { orchestrator: o, source: o });
    const d = await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    expect((await t.post(`/api/items/${id}/archive`, { if_version: d.body.version })).status).toBe(403);
  });
});

describe("orchestrator token: no reopening", () => {
  it.each(["decided", "processing", "archived"])("can't move a %s item back to open", async (status) => {
    const id = uid("O3-reopen");
    await createItem(id, { orchestrator: O });
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    if (status === "processing") await human.post(`/api/items/${id}/claim`);
    if (status === "archived") await human.post(`/api/items/${id}/archive`);
    const patch = await orch.patch(`/api/items/${id}`, { data: { status: "open" } });
    expect(patch.status).toBe(403);
    const put = await orch.put(`/api/items/${id}`, {
      data: { ...(await human.get(`/api/items/${id}`)).body.data, status: "open" },
    });
    expect(put.status).toBe(403);
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe(status);
  });
});

// Once the human decided, the content they decided on is the record: an
// orchestrator token can't rewrite it (only the manager or a human can).
describe("orchestrator token: decided content is frozen", () => {
  const decided = async (status = "decided") => {
    const id = uid("O3-frozen");
    await createItem(id, {
      orchestrator: O,
      type: "proposal",
      title: "Rename a variable",
      links: [{ label: "PR", url: "https://github.com/o/r/pull/1" }],
    });
    await human.post(`/api/items/${id}/decide`, { choice: "approve" });
    if (status === "processing") await human.post(`/api/items/${id}/claim`);
    if (status === "archived") await human.post(`/api/items/${id}/archive`);
    return id;
  };
  const content: [string, unknown][] = [
    ["title", "Drop the prod database"],
    ["summary", "s"],
    ["question", "q?"],
    ["context", "progress"],
    ["options", [{ id: "approve", label: "Drop it" }]],
    ["recommendation", { option: "approve" }],
    ["recommended", "approve"],
    ["cost_of_waiting", "c"],
    ["evidence", [{ label: "e", url: "https://e.test" }]],
    ["links", [{ label: "other", url: "https://other.test" }]],
    ["priority", "high"],
    ["type", "decision"],
    ["source", "elsewhere"],
    ["some_extra", "unknown fields too"],
  ];
  it.each(content)("PATCH %s on a decided item → 403", async (key, value) => {
    const id = await decided();
    const r = await orch.patch(`/api/items/${id}`, { data: { [key]: value } });
    expect(r.status).toBe(403);
    expect((await human.get(`/api/items/${id}`)).body.version).toBe(2);
  });
  it.each(["processing", "archived"])("the same holds once %s", async (status) => {
    const id = await decided(status);
    expect((await orch.patch(`/api/items/${id}`, { data: { title: "x" } })).status).toBe(403);
  });
  it("deleting a content field, a PUT that changes one, and an answer whose data changes one → 403", async () => {
    const id = await decided();
    expect((await orch.patch(`/api/items/${id}`, { data: { links: null } })).status).toBe(403);
    const { data } = (await human.get(`/api/items/${id}`)).body;
    expect((await orch.put(`/api/items/${id}`, { data: { ...data, title: "Drop the prod database" } })).status).toBe(403);
    expect((await orch.post(`/api/items/${id}/qa`, { text: "fyi", data: { title: "x" } })).status).toBe(403);
    expect((await human.get(`/api/items/${id}`)).body.data.title).toBe("Rename a variable");
  });
  it("the manager and humans still can", async () => {
    const id = await decided();
    expect((await manager.patch(`/api/items/${id}`, { data: { summary: "relayed" } })).status).toBe(200);
    expect((await human.patch(`/api/items/${id}`, { data: { context: "notes" } })).status).toBe(200);
  });
  it("open items stay fully editable", async () => {
    const id = uid("O3-open");
    await createItem(id, { orchestrator: O });
    expect((await orch.patch(`/api/items/${id}`, { data: { title: "better title", links: null } })).status).toBe(200);
  });
});

describe("orchestrator token: forbidden", () => {
  const cases: [string, () => Promise<{ status: number }>][] = [
    ["read another orchestrator's item", () => orch.get(`/api/items/${theirs}`)],
    ["read another orchestrator's qa", () => orch.get(`/api/items/${theirs}/qa`)],
    ["read another orchestrator doc", () => orch.get("/api/orchestrators/O4")],
    ["list orchestrators", () => orch.get("/api/orchestrators")],
    ["read meta", () => orch.get("/api/meta/manager")],
    ["read lease", () => orch.get("/api/lease")],
    ["write another orchestrator's item", () => orch.patch(`/api/items/${theirs}`, { data: { summary: "x" } })],
    ["move its item to another orchestrator", () => orch.patch(`/api/items/${mine}`, { data: { orchestrator: "O4" } })],
    ["create an item for another orchestrator", () => orch.put(`/api/items/${uid()}`, { data: { title: "t", orchestrator: "O4" } })],
    ["create an item with no orchestrator", () => orch.put(`/api/items/${uid()}`, { data: { title: "t" } })],
    ["set status decided", () => orch.patch(`/api/items/${mine}`, { data: { status: "decided" } })],
    ["set status archived", () => orch.patch(`/api/items/${mine}`, { data: { status: "archived" } })],
    ["create decided", () => orch.put(`/api/items/${uid()}`, { data: { title: "t", orchestrator: O, status: "decided" } })],
    [
      "write decision on a normal item",
      () => orch.patch(`/api/items/${mine}`, { data: { decision: { choice: "a", decided_at: "x" } } }),
    ],
    [
      "create a non-auto item with a decision",
      () => orch.put(`/api/items/${uid()}`, { data: { title: "t", orchestrator: O, decision: { choice: "a", decided_at: "x" } } }),
    ],
    ["decide", () => orch.post(`/api/items/${mine}/decide`, { choice: "ack" })],
    ["claim", () => orch.post(`/api/items/${mine}/claim`)],
    ["archive another orchestrator's item", () => orch.post(`/api/items/${theirs}/archive`, { if_version: 1 })],
    ["delete an item", () => orch.del(`/api/items/${mine}`)],
    ["answer on another's item", () => orch.post(`/api/items/${theirs}/qa`, { text: "x" })],
    ["post as manager", () => orch.post(`/api/items/${mine}/qa`, { text: "x", role: "manager" })],
    ["patch another orchestrator doc", () => orch.patch("/api/orchestrators/O4", { data: { headline: "x" } })],
    ["replace its existing orchestrator doc", () => orch.put(`/api/orchestrators/${O}`, { data: {} })],
    ["delete its orchestrator doc", () => orch.del(`/api/orchestrators/${O}`)],
    ["write meta", () => orch.patch("/api/meta/manager", { data: {} })],
    ["tick request", () => orch.post("/api/meta/manager/tick-request")],
    ["acquire the lease", () => orch.post("/api/lease/acquire", { session_id: "x" })],
    ["write the schedule", () => orch.put("/api/schedule", { schedule: {} })],
    ["list tokens", () => orch.get("/api/tokens")],
  ];
  it.each(cases)("%s → 403", async (_, run) => {
    expect((await run()).status).toBe(403);
  });
});

describe("manager token", () => {
  it("can do everything but tokens", async () => {
    const id = uid("mgr");
    expect((await manager.put(`/api/items/${id}`, { data: { title: "t" } })).status).toBe(201);
    expect((await manager.post(`/api/items/${id}/decide`, { choice: "ack" })).status).toBe(200);
    expect((await manager.post(`/api/items/${id}/claim`)).status).toBe(200);
    expect((await manager.post(`/api/items/${id}/archive`)).status).toBe(200);
    expect((await manager.post("/api/meta/manager/tick-request")).status).toBe(200);
    expect((await manager.get("/api/lease")).status).toBe(200);
    expect((await manager.del(`/api/items/${id}`)).status).toBe(200);
    expect((await manager.get("/api/tokens")).status).toBe(403);
  });
});
