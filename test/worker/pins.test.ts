// PUT / DELETE /api/pins/...: a human keeps an item, a Reviews PR or an orchestrator at the top of their own lists.
// Pins are per person (the pins table, migration 0010), like snoozes: never on the doc, never seen by anyone else.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { agent, createItem, human, mintToken, person, setRoles, uid } from "./helpers.ts";
import { reportOf, routine, stamp } from "./reviews-helpers.ts";

const A = person("pa@team.test"), B = person("pb@team.test"), V = person("pv@team.test");
const seq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;
const rows = async (email: string) =>
  (await env.DB.prepare("SELECT kind, ref FROM pins WHERE email = ? ORDER BY kind, ref").bind(email).all()).results;
const myPins = async (who: { get: (p: string) => Promise<{ status: number; body: any }> }) => {
  const r = await who.get("/api/state");
  expect(r.status).toBe(200);
  return r.body.pins as Record<string, string>;
};

beforeAll(async () => {
  await setRoles({ "you@test": "admin", "pa@team.test": "decider", "pb@team.test": "decider", "pv@team.test": "viewer" });
});

describe("PUT /api/pins/item/:id", () => {
  it("pins an item for the caller only, without touching the doc", async () => {
    const id = uid("pin");
    const doc = await createItem(id);
    const r = await A.put(`/api/pins/item/${id}`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: "item", ref: id, pinned: true });
    expect(typeof r.body.created_at).toBe("string");
    expect((await myPins(A))[`item:${id}`]).toBe(r.body.created_at);
    expect(await myPins(B)).not.toHaveProperty(`item:${id}`);
    const after = (await human.get(`/api/items/${id}`)).body;
    expect(after.version).toBe(doc.version);
    expect(after.updated_at).toBe(doc.updated_at);
  });

  it("pins an item in any status, and pinning again keeps the first time", async () => {
    const id = uid("pin");
    await createItem(id);
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    await human.post(`/api/items/${id}/archive`);
    const first = await A.put(`/api/pins/item/${id}`, {});
    expect(first.status).toBe(200);
    const before = await seq();
    const again = await A.put(`/api/pins/item/${id}`, {});
    expect(again.status).toBe(200);
    expect(again.body.created_at).toBe(first.body.created_at);
    expect(await seq()).toBe(before); // nothing written, nothing logged
  });

  it("unpins: only the caller's pin goes, and unpinning what isn't pinned is a no-op", async () => {
    const id = uid("pin");
    await createItem(id);
    await A.put(`/api/pins/item/${id}`, {});
    await B.put(`/api/pins/item/${id}`, {});
    const r = await A.del(`/api/pins/item/${id}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ kind: "item", ref: id, pinned: false, created_at: null });
    expect(await myPins(A)).not.toHaveProperty(`item:${id}`);
    expect(await myPins(B)).toHaveProperty(`item:${id}`);
    expect((await A.del(`/api/pins/item/${id}`)).status).toBe(200);
    expect((await A.del(`/api/pins/item/${uid("nope")}`)).status).toBe(200);
  });

  it("is 404 for an item that doesn't exist", async () => {
    const r = await A.put(`/api/pins/item/${uid("nope")}`, {});
    expect(r.status).toBe(404);
  });

  it("matches the caller's email case-insensitively", async () => {
    const id = uid("pin");
    await createItem(id);
    expect((await person("Mixed.Pin@Team.test").put(`/api/pins/item/${id}`, {})).status).toBe(200);
    expect(await rows("mixed.pin@team.test")).toEqual([{ kind: "item", ref: id }]);
  });

  it("is any human's, viewers included", async () => {
    const id = uid("pin");
    await createItem(id);
    expect((await V.put(`/api/pins/item/${id}`, {})).status).toBe(200);
    expect(await myPins(V)).toHaveProperty(`item:${id}`);
  });

  it("is for humans only: manager and orchestrator tokens get 403, and their state has no pins", async () => {
    const id = uid("pin");
    await createItem(id, { orchestrator: "OP1" });
    for (const t of [(await mintToken("manager")).secret, (await mintToken("orchestrator", "OP1")).secret]) {
      const a = agent(t);
      expect((await a.put(`/api/pins/item/${id}`, {})).status).toBe(403);
      expect((await a.del(`/api/pins/item/${id}`)).status).toBe(403);
      expect((await a.put(`/api/pins/orch/OP1`, {})).status).toBe(403);
      expect((await a.get("/api/state")).body.pins).toEqual({});
    }
    expect(await rows("pa@team.test")).not.toContainEqual({ kind: "item", ref: id });
  });
});

describe("PUT /api/pins/orch/:id and /api/pins/pr/:routine/:n", () => {
  it("pins an orchestrator that exists, 404 otherwise", async () => {
    const o = uid("OP");
    await human.put(`/api/orchestrators/${o}`, { data: { goal: "g" } });
    expect((await A.put(`/api/pins/orch/${o}`, {})).status).toBe(200);
    expect(await myPins(A)).toHaveProperty(`orch:${o}`);
    expect((await A.put(`/api/pins/orch/${uid("OP")}`, {})).status).toBe(404);
    expect((await A.del(`/api/pins/orch/${o}`)).body).toMatchObject({ kind: "orch", ref: o, pinned: false });
  });

  it("pins a PR a routine tracks, as <routine>/<n>, gone ones too; 404 for one it doesn't", async () => {
    const r = await routine("pinrv");
    await r.report({ stamp: stamp(0), report: reportOf([11, 12]) });
    await r.report({ stamp: stamp(30), report: reportOf([11]) }); // 12 is gone from the newest report
    const p = await A.put(`/api/pins/pr/${r.id}/11`, {});
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ kind: "pr", ref: `${r.id}/11`, pinned: true });
    expect((await A.put(`/api/pins/pr/${r.id}/12`, {})).status).toBe(200);
    expect(Object.keys(await myPins(A))).toEqual(expect.arrayContaining([`pr:${r.id}/11`, `pr:${r.id}/12`]));
    expect((await A.put(`/api/pins/pr/${r.id}/13`, {})).status).toBe(404);
    expect((await A.put(`/api/pins/pr/${uid("none")}/11`, {})).status).toBe(404);
    expect((await A.put(`/api/pins/pr/${r.id}/0`, {})).status).toBe(400);
    expect((await A.put(`/api/pins/pr/${r.id}/x1`, {})).status).toBe(400);
    expect((await A.del(`/api/pins/pr/${r.id}/11`)).body).toMatchObject({ kind: "pr", ref: `${r.id}/11`, pinned: false });
  });

  it("knows no other kind", async () => {
    expect((await A.put(`/api/pins/run/x`, {})).status).toBe(404);
  });
});

describe("pins in the change log", () => {
  it("logs each pin write as one row, collection pins, doc_id <kind>:<ref>, seen only by the pinner", async () => {
    const id = uid("pin");
    await createItem(id, { orchestrator: "OP2" });
    const since = await seq();
    await A.put(`/api/pins/item/${id}`, {});
    expect((await seq()) - since).toBe(1);
    await A.del(`/api/pins/item/${id}`);
    expect((await seq()) - since).toBe(2);
    const mine = (await A.get(`/api/changes?since=${since}`)).body.changes;
    expect(mine.map((c: any) => [c.collection, c.doc_id, c.op, c.actor])).toEqual([
      ["pins", `item:${id}`, "create", "human:pa@team.test"],
      ["pins", `item:${id}`, "delete", "human:pa@team.test"],
    ]);
    expect((await B.get(`/api/changes?since=${since}`)).body.changes).toEqual([]);
    for (const t of [(await mintToken("manager")).secret, (await mintToken("orchestrator", "OP2")).secret]) {
      const r = await agent(t).get(`/api/changes?since=${since}`);
      expect(r.status).toBe(200);
      expect(r.body.changes.filter((c: any) => c.collection === "pins")).toEqual([]);
    }
  });
});

describe("pins on things that go", () => {
  it("deleting an item or an orchestrator drops everyone's pins on it", async () => {
    const id = uid("pin"), o = uid("OP");
    await createItem(id);
    await human.put(`/api/orchestrators/${o}`, { data: {} });
    await A.put(`/api/pins/item/${id}`, {});
    await B.put(`/api/pins/item/${id}`, {});
    await A.put(`/api/pins/orch/${o}`, {});
    expect((await human.del(`/api/items/${id}`)).status).toBe(200);
    expect((await human.del(`/api/orchestrators/${o}`)).status).toBe(200);
    expect(await myPins(A)).not.toHaveProperty(`item:${id}`);
    expect(await myPins(B)).not.toHaveProperty(`item:${id}`);
    expect(await myPins(A)).not.toHaveProperty(`orch:${o}`);
  });

  it("a delete refused on its version keeps the pins", async () => {
    const id = uid("pin");
    const doc = await createItem(id);
    await A.put(`/api/pins/item/${id}`, {});
    expect((await human.del(`/api/items/${id}?if_version=${doc.version + 1}`)).status).toBe(409);
    expect(await myPins(A)).toHaveProperty(`item:${id}`);
  });

  it("the daily cron drops pins whose item, orchestrator or PR is gone, and keeps the rest", async () => {
    const r = await routine("pinprune");
    await r.report({ stamp: stamp(0), report: reportOf([21, 22]) });
    const live = uid("pin"), o = uid("OP");
    await createItem(live);
    await human.put(`/api/orchestrators/${o}`, { data: {} });
    for (const path of [`item/${live}`, `orch/${o}`, `pr/${r.id}/21`, `pr/${r.id}/22`]) expect((await A.put(`/api/pins/${path}`, {})).status).toBe(200);
    // Targets gone without the routes' cleanup (a Worker from before pins, a pruned PR).
    const ghost = uid("pin"), ghostOrch = uid("OP");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO pins (email, kind, ref, created_at) VALUES ('pa@team.test', 'item', ?, '2026-10-01T00:00:00.000Z')").bind(ghost),
      env.DB.prepare("INSERT INTO pins (email, kind, ref, created_at) VALUES ('pa@team.test', 'orch', ?, '2026-10-01T00:00:00.000Z')").bind(ghostOrch),
      env.DB.prepare("DELETE FROM review_prs WHERE routine = ? AND number = 22").bind(r.id),
    ]);
    const since = await seq();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "17 4 * * *" }), env);
    const left = Object.keys(await myPins(A));
    expect(left).toEqual(expect.arrayContaining([`item:${live}`, `orch:${o}`, `pr:${r.id}/21`]));
    expect(left).not.toContain(`pr:${r.id}/22`);
    expect(left).not.toContain(`item:${ghost}`);
    expect(left).not.toContain(`orch:${ghostOrch}`);
    // Each drop is logged for the pinner's other devices.
    const logged = (await A.get(`/api/changes?since=${since}`)).body.changes.filter((c: any) => c.collection === "pins");
    expect(logged.map((c: any) => c.doc_id)).toEqual(expect.arrayContaining([`item:${ghost}`, `orch:${ghostOrch}`, `pr:${r.id}/22`]));
  });
});

describe("/api/state/delta pins", () => {
  it("sends the pinner's whole map when one changed, and nothing to anyone else", async () => {
    const id = uid("pin"), other = uid("pin");
    await createItem(id);
    await createItem(other);
    await A.put(`/api/pins/item/${other}`, {});
    const c0 = await seq();
    await A.put(`/api/pins/item/${id}`, {});
    const a = await A.get(`/api/state/delta?since=${c0}`);
    expect(a.body.pins).toEqual(await myPins(A));
    expect(a.body.pins).toHaveProperty(`item:${id}`);
    expect(a.body.items).toEqual([]);
    expect((await B.get(`/api/state/delta?since=${c0}`)).body).not.toHaveProperty("pins");
    const mgr = agent((await mintToken("manager")).secret);
    expect((await mgr.get(`/api/state/delta?since=${c0}`)).body).not.toHaveProperty("pins");
  });
});
