// Fleets (docs/api.md "Fleets"): each token reads and writes only its own fleet's items, managers and review
// routines; people see every fleet; a token without a fleet is the default fleet's, which is everything that
// names none.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { agent, createItem, human, mintFleetToken, setRoles, uid } from "./helpers.ts";
import { reportOf, stamp } from "./reviews-helpers.ts";

type Client = ReturnType<typeof agent>;
let A: Client, B: Client, D: Client; // orchestrator tokens of fleets fa and fb, and of the default fleet
let aItem: string, bItem: string, dItem: string;
const cursorNow = async () => (await human.get("/api/changes")).body.cursor as number;
const ids = (docs: { id: string }[]) => docs.map((d) => d.id);

beforeAll(async () => {
  await setRoles({ "you@test": "admin" });
  A = agent((await mintFleetToken("fa")).secret);
  B = agent((await mintFleetToken("fb")).secret);
  D = agent((await mintFleetToken(null)).secret);
  aItem = uid("fa-item");
  bItem = uid("fb-item");
  dItem = uid("d-item");
  expect((await A.put(`/api/items/${aItem}`, { data: { type: "decision", title: "a" } })).status).toBe(201);
  expect((await B.put(`/api/items/${bItem}`, { data: { type: "decision", title: "b" } })).status).toBe(201);
  await createItem(dItem);
});

describe("a token's writes stay in its fleet", () => {
  it("stamps the token's fleet on what it creates, whatever the body says, and none for the default fleet", async () => {
    expect((await human.get(`/api/items/${aItem}`)).body.data.fleet).toBe("fa");
    const id = uid("fa-claims-fb");
    const r = await A.put(`/api/items/${id}`, { data: { type: "info", title: "x", fleet: "fb" } });
    expect(r.status).toBe(201);
    expect(r.body.data.fleet).toBe("fa");
    const d = await D.put(`/api/items/${uid("d")}`, { data: { type: "info", title: "x", fleet: "fa" } });
    expect(d.status).toBe(201);
    expect(d.body.data).not.toHaveProperty("fleet");
  });

  it("keeps it on later writes: a token can't move or drop it", async () => {
    expect((await A.patch(`/api/items/${aItem}`, { data: { fleet: null, summary: "s" } })).body.data.fleet).toBe("fa");
    expect((await A.patch(`/api/items/${aItem}`, { data: { fleet: "fb" } })).body.data.fleet).toBe("fa");
    const replaced = await A.put(`/api/items/${aItem}`, { data: { type: "decision", title: "a" } });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.fleet).toBe("fa");
  });

  it("refuses every read and write of another fleet's item, pinned or not, and changes nothing", async () => {
    const before = (await human.get(`/api/items/${aItem}`)).body;
    const v = before.version;
    const refused = [
      await B.get(`/api/items/${aItem}`),
      await B.get(`/api/items/${aItem}/qa`),
      await B.put(`/api/items/${aItem}`, { data: { type: "decision", title: "taken" } }),
      await B.put(`/api/items/${aItem}`, { data: { type: "decision", title: "taken" }, if_version: v }),
      await B.patch(`/api/items/${aItem}`, { data: { summary: "x" } }),
      await B.post(`/api/items/${aItem}/decide`, { choice: "ack" }),
      await B.post(`/api/items/${aItem}/qa`, { text: "answer", data: { summary: "x" } }),
      await B.post(`/api/items/${aItem}/withdraw`, { if_version: v }),
      await B.post(`/api/items/${aItem}/archive`, { if_version: v }),
      await B.post(`/api/items/${aItem}/claim`, {}),
      await B.del(`/api/items/${aItem}`),
      await B.del(`/api/items/${aItem}?if_version=${v}`),
      await D.get(`/api/items/${aItem}`),
      await D.patch(`/api/items/${aItem}`, { data: { summary: "x" } }),
      await A.patch(`/api/items/${dItem}`, { data: { summary: "x" } }),
    ];
    expect(refused.map((r) => [r.status, r.body.error])).toEqual(refused.map(() => [403, "forbidden"]));
    expect(refused[0].body.message).toMatch(/another fleet/);
    expect((await human.get(`/api/items/${aItem}`)).body).toEqual(before);
  });

  it("refuses a batch that touches another fleet's item, writing none of it", async () => {
    const mine = uid("fb-batch");
    const r = await B.post("/api/batch", {
      ops: [
        { op: "item.put", id: mine, data: { type: "info", title: "mine" } },
        { op: "item.patch", id: aItem, data: { summary: "x" } },
      ],
    });
    expect([r.status, r.body.index]).toEqual([403, 1]);
    expect((await human.get(`/api/items/${mine}`)).status).toBe(404);
  });

  it("decides and claims only its own fleet's items", async () => {
    const id = uid("fa-decide");
    await A.put(`/api/items/${id}`, { data: { type: "decision", title: "d" } });
    expect((await B.post(`/api/items/${id}/decide`, { choice: "ack" })).status).toBe(403);
    expect((await A.post(`/api/items/${id}/decide`, { choice: "ack" })).status).toBe(200);
    expect((await B.post(`/api/items/${id}/claim`, {})).status).toBe(403);
    expect((await A.post(`/api/items/${id}/claim`, {})).body.data.status).toBe("processing");
    expect((await B.del(`/api/items/${id}`)).status).toBe(403);
    // A pin on any version but the one it checked is a 409 (with its own doc), never a delete on that version.
    const v = (await human.get(`/api/items/${id}`)).body.version;
    const ahead = await A.del(`/api/items/${id}?if_version=${v + 1}`);
    expect([ahead.status, ahead.body.current?.version]).toEqual([409, v]);
    expect((await A.del(`/api/items/${id}?if_version=${v}`)).status).toBe(200);
  });
});

describe("a token reads only its fleet", () => {
  it("lists, snapshots and counts only its own fleet's items; ?fleet= can't widen it", async () => {
    for (const [c, own, others] of [
      [A, aItem, [bItem, dItem]],
      [B, bItem, [aItem, dItem]],
      [D, dItem, [aItem, bItem]],
    ] as const) {
      const list = ids((await c.get("/api/items")).body.items);
      expect(list).toContain(own);
      for (const o of others) expect(list).not.toContain(o);
      expect(ids((await c.get("/api/items?fleet=fa")).body.items)).not.toContain(own === aItem ? bItem : aItem);
      const state = (await c.get("/api/state")).body;
      expect(ids(state.items)).toContain(own);
      for (const o of others) expect(ids(state.items)).not.toContain(o);
    }
    const archived = uid("fa-arch");
    await A.put(`/api/items/${archived}`, { data: { type: "info", title: "a" } });
    await human.post(`/api/items/${archived}/archive`);
    const count = (await env.DB.prepare("SELECT count(*) AS n FROM docs WHERE collection = 'items' AND status = 'archived' AND fleet = 'fa'").first<{ n: number }>())!.n;
    expect((await A.get("/api/state")).body.archived_total).toBe(count);
  });

  it("names its fleet in /me, and default for a token without one", async () => {
    expect((await A.get("/api/me")).body).toMatchObject({ kind: "token", scope: "manager", fleet: "fa" });
    expect((await D.get("/api/me")).body).toMatchObject({ kind: "token", scope: "manager", fleet: "default" });
  });

  it("follows only its own fleet's changes, and the deployment-wide ones", async () => {
    const c0 = await cursorNow();
    const a2 = uid("fa-ch"), b2 = uid("fb-ch");
    await A.put(`/api/items/${a2}`, { data: { type: "info", title: "a" } });
    await B.put(`/api/items/${b2}`, { data: { type: "info", title: "b" } });
    await human.post(`/api/items/${a2}/qa`, { text: "q" });
    await human.put("/api/users/fleet-person@team.test", { role: "viewer" });
    await human.put("/api/meta/fleet-note", { data: { x: 1 } });
    const seen = async (c: Client, q = "") => (await c.get(`/api/changes?since=${c0}${q}`)).body.changes.map((r: any) => `${r.collection}/${r.doc_id}`);
    const a = await seen(A);
    expect(a).toEqual(expect.arrayContaining([`items/${a2}`, "users/fleet-person@team.test", "meta/fleet-note"]));
    const qa = (rows: string[]) => rows.some((x) => x.startsWith(`items/${a2}/qa/`));
    expect(qa(a)).toBe(true);
    expect(a).not.toContain(`items/${b2}`);
    const b = await seen(B, "&fleet=fa");
    expect(b).toContain(`items/${b2}`);
    expect(b).not.toContain(`items/${a2}`);
    expect(qa(b)).toBe(false);
    const d = await seen(D);
    expect(d).toEqual(expect.arrayContaining(["users/fleet-person@team.test", "meta/fleet-note"]));
    expect(d).not.toContain(`items/${a2}`);
    expect(d).not.toContain(`items/${b2}`);
    // A person sees every fleet, or one with ?fleet=.
    expect(await seen(human as unknown as Client)).toEqual(expect.arrayContaining([`items/${a2}`, `items/${b2}`]));
    expect(await seen(human as unknown as Client, "&fleet=fb")).not.toContain(`items/${a2}`);
    expect(await seen(human as unknown as Client, "&fleet=default")).not.toContain(`items/${b2}`);
  });

  it("gets its own fleet's delta only", async () => {
    const c0 = await cursorNow();
    const a2 = uid("fa-d"), b2 = uid("fb-d");
    await A.put(`/api/items/${a2}`, { data: { type: "info", title: "a" } });
    await B.put(`/api/items/${b2}`, { data: { type: "info", title: "b" } });
    await human.post(`/api/items/${b2}/qa`, { text: "q" });
    const d = (await A.get(`/api/state/delta?since=${c0}`)).body;
    expect(ids(d.items)).toEqual([a2]);
    expect(d.deleted).toEqual([]);
    expect(d.qa_changed).toEqual([]);
  });

  it("loses a moved item from its delta as a delete, without seeing it again", async () => {
    const moved = uid("fa-moved");
    await A.put(`/api/items/${moved}`, { data: { type: "info", title: "a" } });
    const c0 = await cursorNow();
    expect((await human.patch(`/api/items/${moved}`, { data: { fleet: "fb" } })).body.data.fleet).toBe("fb");
    await human.patch(`/api/items/${moved}`, { data: { summary: "secret" } });
    const a = (await A.get(`/api/state/delta?since=${c0}`)).body;
    expect(a.items).toEqual([]);
    expect(a.deleted).toEqual([{ collection: "items", id: moved }]);
    expect(JSON.stringify(a)).not.toContain("secret");
    expect(ids((await B.get(`/api/state/delta?since=${c0}`)).body.items)).toEqual([moved]);
    // Never in fb: nothing about it reaches the default fleet.
    const d = (await D.get(`/api/state/delta?since=${c0}`)).body;
    expect(d.deleted).toEqual([]);
    expect((await A.get(`/api/items/${moved}`)).status).toBe(403);
    expect((await B.patch(`/api/items/${moved}`, { data: { summary: "b" } })).status).toBe(200);
  });
});

describe("people see and move every fleet", () => {
  it("lists every fleet, and filters with ?fleet=", async () => {
    expect(ids((await human.get("/api/items")).body.items)).toEqual(expect.arrayContaining([aItem, bItem, dItem]));
    const fa = ids((await human.get("/api/items?fleet=fa")).body.items);
    expect(fa).toContain(aItem);
    expect(fa).not.toContain(bItem);
    const def = ids((await human.get("/api/items?fleet=default")).body.items);
    expect(def).toContain(dItem);
    expect(def).not.toContain(aItem);
    expect((await human.get("/api/items?fleet=Not_A_Fleet")).status).toBe(400);
    expect(ids((await human.get("/api/state")).body.items)).toEqual(expect.arrayContaining([aItem, bItem, dItem]));
  });

  it("an admin moves an item with fleet, keeps it on a replace that leaves it out, and is held to the id rule", async () => {
    const id = uid("move");
    await createItem(id);
    expect((await human.patch(`/api/items/${id}`, { data: { fleet: "fa" } })).body.data.fleet).toBe("fa");
    expect((await human.put(`/api/items/${id}`, { data: { type: "decision", title: "kept" } })).body.data.fleet).toBe("fa");
    for (const bad of ["Fa", "*", "", 5, "x".repeat(33)]) {
      expect((await human.patch(`/api/items/${id}`, { data: { fleet: bad } })).status, String(bad)).toBe(400);
    }
    expect((await human.patch(`/api/items/${id}`, { data: { fleet: "default" } })).body.data).not.toHaveProperty("fleet");
    expect((await human.patch(`/api/items/${id}`, { data: { fleet: "fb" } })).body.data.fleet).toBe("fb");
    expect((await human.patch(`/api/items/${id}`, { data: { fleet: null } })).body.data).not.toHaveProperty("fleet");
  });

  it("a person's decide works on any fleet's item", async () => {
    const id = uid("fa-human");
    await A.put(`/api/items/${id}`, { data: { type: "decision", title: "d" } });
    expect((await human.post(`/api/items/${id}/decide`, { choice: "ack" })).body.data).toMatchObject({ status: "decided", fleet: "fa" });
  });
});

describe("manager docs", () => {
  it("belong to the first fleet to create them: another fleet can't read, replace, patch or delete them", async () => {
    const o = uid("I");
    const c = await A.put(`/api/orchestrators/${o}`, { data: { goal: "g", fleet: "fb" } });
    expect(c.status).toBe(201);
    expect(c.body.data.fleet).toBe("fa");
    const refused = [
      await B.get(`/api/orchestrators/${o}`),
      await B.put(`/api/orchestrators/${o}`, { data: { goal: "mine" } }),
      await B.patch(`/api/orchestrators/${o}`, { data: { goal: "mine" } }),
      await B.del(`/api/orchestrators/${o}`),
      await D.get(`/api/orchestrators/${o}`),
    ];
    expect(refused.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect((await human.get(`/api/orchestrators/${o}`)).body.data).toMatchObject({ goal: "g", fleet: "fa" });
    expect(ids((await A.get("/api/orchestrators")).body.orchestrators)).toContain(o);
    expect(ids((await B.get("/api/orchestrators")).body.orchestrators)).not.toContain(o);
    expect(ids((await B.get("/api/state")).body.orchestrators)).not.toContain(o);
    expect((await A.patch(`/api/orchestrators/${o}`, { data: { fleet: null } })).body.data.fleet).toBe("fa");
    expect((await A.del(`/api/orchestrators/${o}`)).status).toBe(200);
  });

  it("a manager token works only in its fleet, even on items that name its id", async () => {
    const o = uid("I");
    const mgr = agent((await mintFleetToken("fa", "orchestrator", o)).secret);
    expect((await mgr.get("/api/me")).body).toMatchObject({ scope: "orchestrator", orchestrator: o, fleet: "fa" });
    const own = uid("own");
    const c = await mgr.put(`/api/items/${own}`, { data: { type: "decision", title: "mine", orchestrator: o } });
    expect(c.status).toBe(201);
    expect(c.body.data.fleet).toBe("fa");
    expect((await mgr.put(`/api/orchestrators/${o}`, { data: { goal: "g" } })).body.data.fleet).toBe("fa");
    // Fleet fb's orchestrator posts an item naming the same manager id: it stays in fb, out of the manager's view.
    const stray = uid("stray");
    await B.put(`/api/items/${stray}`, { data: { type: "decision", title: "fb", orchestrator: o } });
    expect(ids((await mgr.get("/api/items")).body.items)).toEqual([own]);
    expect(ids((await mgr.get("/api/state")).body.items)).toEqual([own]);
    expect((await mgr.get(`/api/items/${stray}`)).status).toBe(403);
    expect((await mgr.patch(`/api/items/${stray}`, { data: { summary: "x" } })).status).toBe(403);
    const ch = (await mgr.get("/api/changes?since=0")).body.changes.map((r: any) => r.doc_id);
    expect(ch).toContain(own);
    expect(ch).not.toContain(stray);
  });
});

describe("review routines", () => {
  it("belong to the fleet that first wrote them", async () => {
    const r = uid("rv");
    const own = agent((await mintFleetToken("fa", "orchestrator", r)).secret);
    expect((await own.post("/api/reviews/report", { stamp: stamp(0), result: "ok", report: reportOf([1]) })).status).toBe(201);
    expect((await env.DB.prepare("SELECT fleet FROM review_routines WHERE routine = ?").bind(r).first<{ fleet: string }>())!.fleet).toBe("fa");
    // Another fleet's token for the same id can neither write nor read it.
    const other = agent((await mintFleetToken("fb", "orchestrator", r)).secret);
    expect((await other.post("/api/reviews/report", { stamp: stamp(1), result: "ok", report: reportOf([2]) })).status).toBe(403);
    expect((await other.post(`/api/reviews/runs/${stamp(2)}/start`, {})).status).toBe(403);
    expect((await other.get(`/api/reviews/${r}`)).status).toBe(403);
    // Orchestrator tokens list only their own fleet's routines; people list them all.
    expect((await A.get("/api/reviews")).body.routines.map((x: any) => x.routine)).toContain(r);
    expect((await B.get("/api/reviews")).body.routines.map((x: any) => x.routine)).not.toContain(r);
    expect((await B.get(`/api/reviews/${r}`)).status).toBe(403);
    expect((await B.get("/api/state")).body.routines.map((x: any) => x.id)).not.toContain(r);
    expect((await A.get("/api/state")).body.routines.map((x: any) => x.id)).toContain(r);
    expect((await human.get("/api/reviews")).body.routines.map((x: any) => x.routine)).toContain(r);
    // Its change rows carry its fleet.
    const c = await env.DB.prepare("SELECT DISTINCT fleet FROM changes WHERE collection = 'reviews' AND doc_id = ?").bind(r).all<{ fleet: string }>();
    expect(c.results).toEqual([{ fleet: "fa" }]);
  });
});

describe("a 409 never hands a token another fleet's doc", () => {
  it("checks the fleet before the pin: a wrong if_version on another fleet's doc is 403 with no current", async () => {
    const o = uid("I");
    await A.put(`/api/orchestrators/${o}`, { data: { goal: "secret goal" } });
    const id = uid("fa-pin");
    await A.put(`/api/items/${id}`, { data: { type: "decision", title: "secret title" } });
    const v = (await human.get(`/api/items/${id}`)).body.version;
    for (const pin of [0, v + 1]) {
      const refused = [
        await B.put(`/api/items/${id}`, { data: { type: "info", title: "x" }, if_version: pin }),
        await B.patch(`/api/items/${id}`, { data: { summary: "x" }, if_version: pin }),
        await B.post(`/api/items/${id}/decide`, { choice: "ack", if_version: pin }),
        await B.post(`/api/items/${id}/claim`, { if_version: pin }),
        await B.post(`/api/items/${id}/archive`, { if_version: pin }),
        await B.post(`/api/items/${id}/withdraw`, { if_version: pin }),
        await B.post(`/api/items/${id}/qa`, { text: "a", if_version: pin }),
        await B.del(`/api/items/${id}?if_version=${pin}`),
        await B.put(`/api/orchestrators/${o}`, { data: { goal: "x" }, if_version: pin }),
        await B.patch(`/api/orchestrators/${o}`, { data: { goal: "x" }, if_version: pin }),
        await B.del(`/api/orchestrators/${o}?if_version=${pin}`),
        await B.post("/api/batch", { ops: [{ op: "orchestrator.patch", id: o, data: { goal: "x" }, if_version: pin }] }),
        await B.post("/api/batch", { ops: [{ op: "item.patch", id, data: { summary: "x" }, if_version: pin }] }),
      ];
      expect(refused.map((r) => r.status), `if_version ${pin}`).toEqual(refused.map(() => 403));
      for (const r of refused) expect(r.body).not.toHaveProperty("current");
      expect(JSON.stringify(refused.map((r) => r.body))).not.toMatch(/secret/);
    }
  });
});

describe("moves between fleets", () => {
  it("wake the fleet a doc left, in its change feed, and its delta drops it", async () => {
    const id = uid("fa-wake");
    await A.put(`/api/items/${id}`, { data: { type: "info", title: "a" } });
    const c0 = await cursorNow();
    await human.patch(`/api/items/${id}`, { data: { fleet: "fb" } });
    const rows = (await A.get(`/api/changes?since=${c0}`)).body.changes;
    expect(rows.map((r: any) => [r.collection, r.doc_id, r.status])).toEqual([["items", id, null]]);
    // The delta drops it even when everything about it before the cursor was pruned.
    await env.DB.prepare("DELETE FROM changes WHERE collection = 'items' AND doc_id = ? AND seq <= ?").bind(id, c0).run();
    expect((await A.get(`/api/state/delta?since=${c0}`)).body.deleted).toEqual([{ collection: "items", id }]);
    // Later writes in its new fleet don't reach the old one at all.
    const c1 = await cursorNow();
    await B.patch(`/api/items/${id}`, { data: { summary: "b" } });
    expect((await A.get(`/api/changes?since=${c1}`)).body.changes).toEqual([]);
    expect((await A.get(`/api/state/delta?since=${c1}`)).body.deleted).toEqual([]);
  });

  it("drop a moved manager doc from its fleet's and its manager token's delta", async () => {
    const o = uid("I");
    const mgr = agent((await mintFleetToken("fa", "orchestrator", o)).secret);
    await mgr.put(`/api/orchestrators/${o}`, { data: { goal: "g" } });
    const c0 = await cursorNow();
    await human.patch(`/api/orchestrators/${o}`, { data: { fleet: "fb" } });
    for (const c of [A, mgr]) {
      const d = (await c.get(`/api/state/delta?since=${c0}`)).body;
      expect(d.orchestrators).toEqual([]);
      expect(d.deleted).toEqual([{ collection: "orchestrators", id: o }]);
      expect(ids((await c.get("/api/state")).body.orchestrators)).not.toContain(o);
    }
    expect(ids((await B.get(`/api/state/delta?since=${c0}`)).body.orchestrators)).toEqual([o]);
  });
});

describe("review routines of another fleet", () => {
  it("are 403 to read through every route, and to update a run request on", async () => {
    const r = uid("rv");
    const own = agent((await mintFleetToken("fa", "orchestrator", r)).secret);
    await own.post("/api/reviews/report", { stamp: stamp(0), result: "ok", report: reportOf([1]) });
    expect((await human.post(`/api/reviews/${r}/run-request`, {})).status).toBe(201);
    const req = (await human.get(`/api/reviews/${r}/run-request`)).body.request;
    const other = agent((await mintFleetToken("fb", "orchestrator", r)).secret);
    const refused = [
      await other.get(`/api/reviews/${r}`),
      await other.get(`/api/reviews/${r}/prs/1`),
      await other.get(`/api/reviews/${r}/runs/${stamp(0)}`),
      await other.get(`/api/reviews/${r}/run-request`),
      await other.post(`/api/reviews/run-requests/${req.id}`, { status: "starting" }),
    ];
    expect(refused.map((x) => x.status)).toEqual([403, 403, 403, 403, 403]);
    expect((await human.get(`/api/reviews/${r}/run-request`)).body.request).toEqual(req);
    expect((await own.post(`/api/reviews/run-requests/${req.id}`, { status: "starting" })).status).toBe(200);
  });
});

describe("token fleet values", () => {
  it("reads a stored 'default' as the default fleet, and refuses a token whose fleet isn't a fleet id", async () => {
    const t = await mintFleetToken("default");
    const c = agent(t.secret);
    expect((await c.get("/api/me")).body.fleet).toBe("default");
    expect(ids((await c.get("/api/items")).body.items)).toContain(dItem);
    const bad = await mintFleetToken("Not A Fleet");
    expect((await agent(bad.secret).get("/api/me")).status).toBe(401);
  });

  it("keeps a stored fleet: null as it is, so a manager token's write on a decided item isn't a content change", async () => {
    const o = uid("I"), id = uid("null-fleet");
    const mgr = agent((await mintFleetToken(null, "orchestrator", o)).secret);
    await createItem(id, { orchestrator: o, source: o });
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.fleet', json('null')) WHERE collection = 'items' AND id = ?").bind(id).run();
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    const r = await mgr.patch(`/api/items/${id}`, { data: { assignee: "a@team.test" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.fleet).toBeNull();
  });
});

describe("shared meta docs", () => {
  it("a meta id with a colon that names no per-fleet doc stays in the default fleet's feed", async () => {
    const c0 = await cursorNow();
    expect((await human.put("/api/meta/notes:v1", { data: { x: 1 } })).status).toBeLessThan(300);
    const rows = (await D.get(`/api/changes?since=${c0}`)).body.changes.map((r: any) => r.doc_id);
    expect(rows).toContain("notes:v1");
  });
});
