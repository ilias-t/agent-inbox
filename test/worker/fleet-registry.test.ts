// The fleet registry and fleet-bound tokens (docs/api.md "Fleets", "Fleets registry", "Tokens"): who reads and
// writes fleets/<id>, what a fleet doc may hold, minting a token for a fleet (a manager token in the fleet that
// owns its id), people's `fleets` map, and the 400 a person gets for a fleet that isn't registered.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { StateResponse } from "../../shared/types.ts";
import { agent, createItem, human, mintFleetToken, person, registerFleet, setRoles, uid } from "./helpers.ts";

type Client = ReturnType<typeof agent>;
let A: Client, D: Client, M: Client; // fleet fa's and the default fleet's orchestrator tokens, a manager token in fa
const mint = (body: Record<string, unknown>) => human.post("/api/tokens", { name: uid("tok"), ...body });

beforeAll(async () => {
  await setRoles({ "you@test": "admin", "viewer@team.test": "viewer", "decider@team.test": "decider" });
  A = agent((await mintFleetToken("fa")).secret);
  D = agent((await mintFleetToken(null)).secret);
  M = agent((await mintFleetToken("fa", "orchestrator", uid("M"))).secret);
  await registerFleet("fb");
});

describe("reading the registry", () => {
  it("people read every fleet; an orchestrator token its own fleet's; a manager token none", async () => {
    expect((await human.put("/api/fleets/fa", { data: { label: "Fleet A" } })).status).toBe(200);
    for (const who of [human, person("viewer@team.test"), person("decider@team.test")]) {
      const ids = (await who.get("/api/fleets")).body.fleets.map((f: { id: string }) => f.id);
      expect(ids).toEqual(expect.arrayContaining(["fa", "fb"]));
      expect((await who.get("/api/fleets/fb")).status).toBe(200);
    }
    expect((await A.get("/api/fleets")).body.fleets.map((f: { id: string }) => f.id)).toEqual(["fa"]);
    expect((await A.get("/api/fleets/fa")).body.data).toEqual({ label: "Fleet A" });
    // Another fleet's is 403 whether or not it exists, so a token can't probe for fleets.
    expect((await A.get("/api/fleets/fb")).status).toBe(403);
    expect((await A.get("/api/fleets/nope")).status).toBe(403);
    expect((await A.get("/api/fleets/default")).status).toBe(403);
    expect((await D.get("/api/fleets/fa")).status).toBe(403);
    expect((await M.get("/api/fleets")).status).toBe(403);
    expect((await M.get("/api/fleets/fa")).status).toBe(403);
    expect((await human.get("/api/fleets/nope")).status).toBe(404);
    expect((await human.get("/api/fleets/Not.A.Fleet")).status).toBe(400);
  });
});

describe("writing the registry", () => {
  it("validates the id and every field, trims the label and lowercases the colour", async () => {
    const id = uid("fv").toLowerCase();
    const r = await human.put(`/api/fleets/${id}`, { data: { label: "  Side A ", color: "#AABBCC", id_prefix: "S", fleet: undefined } });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ label: "Side A", color: "#aabbcc", id_prefix: "S" });
    for (const data of [{ label: "" }, { label: "x".repeat(65) }, { label: 3 }, { color: "red" }, { id_prefix: "1x" }, { id_prefix: "ABCDEFGHI" }, { owner: "me" }]) {
      expect((await human.put(`/api/fleets/${id}`, { data })).status, JSON.stringify(data)).toBe(400);
      expect((await human.patch(`/api/fleets/${id}`, { data })).status, JSON.stringify(data)).toBe(400);
    }
    for (const bad of ["Upper", "1abc", "a".repeat(33), "has.dot"]) expect((await human.put(`/api/fleets/${bad}`, { data: {} })).status, bad).toBe(400);
    expect((await human.get(`/api/fleets/${id}`)).body.data).toEqual({ label: "Side A", color: "#aabbcc", id_prefix: "S" });
  });

  it("merges a PATCH (a null drops a field), replaces on PUT, and pins on if_version", async () => {
    const id = uid("fp").toLowerCase();
    expect((await human.patch(`/api/fleets/${id}`, { data: { label: "x" } })).status).toBe(404);
    const v1 = (await human.put(`/api/fleets/${id}`, { data: { label: "One", color: "#000000" } })).body.version;
    const p = await human.patch(`/api/fleets/${id}`, { data: { color: null, id_prefix: "Q" }, if_version: v1 });
    expect(p.body.data).toEqual({ label: "One", id_prefix: "Q" });
    expect((await human.patch(`/api/fleets/${id}`, { data: { label: "Two" }, if_version: v1 })).status).toBe(409);
    expect((await human.put(`/api/fleets/${id}`, { data: { label: "Three", color: null } })).body.data).toEqual({ label: "Three" });
  });

  it("is an admin's; deciders and viewers are 403", async () => {
    for (const email of ["viewer@team.test", "decider@team.test"]) {
      expect((await person(email).put("/api/fleets/fb", { data: { label: "x" } })).status).toBe(403);
      expect((await person(email).patch("/api/fleets/fb", { data: { label: "x" } })).status).toBe(403);
    }
  });

  it("lets an orchestrator token create its own fleet's doc, never replace it or touch another's", async () => {
    // The default fleet's token labels the default fleet once.
    await env.DB.prepare("DELETE FROM docs WHERE collection = 'fleets' AND id = 'default'").run();
    const made = await D.put("/api/fleets/default", { data: { label: "Main" } });
    expect(made.status).toBe(201);
    expect(made.body.updated_by).toMatch(/^token:/);
    const v = made.body.version;
    // Once it exists: 403, before any pin is checked (a wrong one never answers 409 with the doc).
    expect((await D.put("/api/fleets/default", { data: { label: "Again" } })).status).toBe(403);
    expect((await D.put("/api/fleets/default", { data: { label: "Again" }, if_version: v + 5 })).status).toBe(403);
    expect((await D.patch("/api/fleets/default", { data: { label: "Again" } })).status).toBe(403);
    expect((await A.put("/api/fleets/fa", { data: { label: "Mine" } })).status).toBe(403);
    expect((await A.put("/api/fleets/fb", { data: {} })).status).toBe(403);
    expect((await A.put("/api/fleets/fresh", { data: {} })).status).toBe(403);
    expect((await M.put("/api/fleets/fa", { data: {} })).status).toBe(403);
    expect((await human.get("/api/fleets/default")).body.data).toEqual({ label: "Main" });
  });

  it("has no DELETE and no batch op", async () => {
    expect((await human.del("/api/fleets/fb")).status).toBeGreaterThanOrEqual(400);
    expect((await human.get("/api/fleets/fb")).status).toBe(200);
    const r = await human.post("/api/batch", { ops: [{ op: "fleet.put", id: "fb", data: {} }] });
    expect(r.status).toBe(400);
  });
});

describe("minting a token for a fleet", () => {
  it("mints an orchestrator token for a registered fleet or the default one, and refuses an unknown one", async () => {
    const fa = await mint({ scope: "manager", fleet: "fa" });
    expect(fa.status).toBe(201);
    expect(fa.body.token.fleet).toBe("fa");
    expect((await agent(fa.body.secret).get("/api/me")).body).toMatchObject({ kind: "token", scope: "manager", fleet: "fa" });
    expect((await mint({ scope: "manager" })).body.token.fleet).toBe("default");
    expect((await mint({ scope: "manager", fleet: "default" })).body.token.fleet).toBe("default");
    expect((await mint({ scope: "manager", fleet: null })).body.token.fleet).toBe("default");
    const typo = await mint({ scope: "manager", fleet: "fx" });
    expect(typo.status).toBe(400);
    expect(typo.body.message).toMatch(/No fleet fx/);
    expect((await mint({ scope: "manager", fleet: "Bad Fleet" })).status).toBe(400);
    const list = (await human.get("/api/tokens")).body.tokens as { id: string; fleet: string }[];
    expect(list.find((t) => t.id === fa.body.token.id)?.fleet).toBe("fa");
    expect(list.every((t) => typeof t.fleet === "string")).toBe(true);
  });

  it("puts a manager token in the fleet that owns its id, and refuses another fleet, default included", async () => {
    const O = uid("O");
    expect((await A.put(`/api/orchestrators/${O}`, { data: { goal: "g" } })).status).toBe(201);
    const inherited = await mint({ scope: "orchestrator", orchestrator: O });
    expect(inherited.body.token.fleet).toBe("fa");
    expect((await mint({ scope: "orchestrator", orchestrator: O, fleet: "fa" })).status).toBe(201);
    for (const fleet of ["fb", "default"]) {
      const r = await mint({ scope: "orchestrator", orchestrator: O, fleet });
      expect(r.status, fleet).toBe(409);
      expect(r.body.message).toMatch(new RegExp(`Manager ${O} belongs to fleet fa`));
    }
    // The token works on its doc in its fleet.
    expect((await agent(inherited.body.secret).patch(`/api/orchestrators/${O}`, { data: { status: "running" } })).status).toBe(200);
    // No owner yet: the fleet asked for, which a live token then holds.
    const N = uid("N");
    expect((await mint({ scope: "orchestrator", orchestrator: N, fleet: "fb" })).body.token.fleet).toBe("fb");
    expect((await mint({ scope: "orchestrator", orchestrator: N })).body.token.fleet).toBe("fb");
    expect((await mint({ scope: "orchestrator", orchestrator: N, fleet: "fa" })).status).toBe(409);
  });

  it("keeps the name rule and its message", async () => {
    const name = uid("same");
    expect((await human.post("/api/tokens", { name, scope: "manager", fleet: "fa" })).status).toBe(201);
    const r = await human.post("/api/tokens", { name, scope: "manager", fleet: "fb" });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/already named/);
  });

  it("lands one of two concurrent mints of one manager id in different fleets", async () => {
    const O = uid("race");
    const rs = await Promise.all([mint({ scope: "orchestrator", orchestrator: O, fleet: "fa" }), mint({ scope: "orchestrator", orchestrator: O, fleet: "fb" })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const { results } = await env.DB.prepare("SELECT DISTINCT fleet FROM tokens WHERE orchestrator = ? AND revoked_at IS NULL").bind(O).all();
    expect(results).toHaveLength(1);
  });

  it("refuses a token creating a manager doc whose id another fleet's live token holds", async () => {
    const O = uid("held");
    expect((await mint({ scope: "orchestrator", orchestrator: O, fleet: "fb" })).status).toBe(201);
    expect((await A.put(`/api/orchestrators/${O}`, { data: { goal: "take" } })).status).toBe(403);
    expect((await A.post("/api/batch", { ops: [{ op: "orchestrator.put", id: O, data: { goal: "take" } }] })).status).toBe(403);
    expect((await human.get(`/api/orchestrators/${O}`)).status).toBe(404);
    // Its own fleet's token may, and so may a person.
    const B = agent((await mintFleetToken("fb")).secret);
    expect((await B.put(`/api/orchestrators/${O}`, { data: { goal: "mine" } })).status).toBe(201);
    const P = uid("held-p");
    expect((await mint({ scope: "orchestrator", orchestrator: P, fleet: "fb" })).status).toBe(201);
    expect((await human.put(`/api/orchestrators/${P}`, { data: { goal: "admin", fleet: "fb" } })).status).toBe(201);
  });
});

describe("unknown fleets", () => {
  it("are 400 wherever a person names one, and default always passes", async () => {
    const id = uid("i");
    await createItem(id);
    const cases: [string, Promise<{ status: number; body: any }>][] = [
      ["lease", human.get("/api/lease?fleet=typo")],
      ["acquire", human.post("/api/lease/acquire?fleet=typo", { session_id: "s" })],
      ["schedule get", human.get("/api/schedule?fleet=typo")],
      ["schedule put", human.put("/api/schedule", { fleet: "typo", schedule: { work_hours: "09:00-17:00 Mon-Fri", timezone: "UTC", pickup_interval_min: 10, sweep_interval_min: 30 } })],
      ["schedule del", human.del("/api/schedule?fleet=typo")],
      ["tick", human.post("/api/meta/manager/tick-request", { fleet: "typo" })],
      ["meta put", human.put("/api/meta/manager:typo", { data: { x: 1 } })],
      ["batch meta", human.post("/api/batch", { ops: [{ op: "meta.put", id: "manager", data: { x: 1 } }, { op: "meta.put", id: "manager:typo", data: { x: 1 } }] })],
      ["item move", human.patch(`/api/items/${id}`, { data: { fleet: "typo" } })],
      ["item put", human.put(`/api/items/${uid("i")}`, { data: { type: "info", title: "t", fleet: "typo" } })],
      ["batch item", human.post("/api/batch", { ops: [{ op: "item.patch", id, data: { fleet: "typo" } }] })],
      ["manager move", human.put(`/api/orchestrators/${uid("O")}`, { data: { fleet: "typo" } })],
      ["items filter", human.get("/api/items?fleet=typo")],
      ["changes", human.get("/api/changes?since=0&fleet=typo")],
      ["changes bootstrap", human.get("/api/changes?fleet=typo")],
    ];
    for (const [what, p] of cases) {
      const r = await p;
      expect(r.status, what).toBe(400);
      expect(r.body.message, what).toMatch(/No fleet typo/);
    }
    expect((await human.post("/api/batch", { ops: [{ op: "meta.put", id: "manager:typo", data: {} }] })).body.index).toBe(0);
    const { results } = await env.DB.prepare("SELECT id FROM docs WHERE id LIKE '%typo%' OR json_extract(data, '$.fleet') = 'typo'").all();
    expect(results).toEqual([]);
    for (const path of ["/api/lease?fleet=default", "/api/schedule?fleet=default", "/api/items?fleet=default", "/api/changes?fleet=default", "/api/lease?fleet=fb"]) {
      expect((await human.get(path)).status, path).toBe(200);
    }
  });

  it("let a doc keep a fleet that isn't registered when a write leaves it unchanged", async () => {
    const id = uid("orphan");
    await createItem(id);
    await env.DB.prepare(`UPDATE docs SET data = json_set(data, '$.fleet', 'gone') WHERE collection = 'items' AND id = ?`).bind(id).run();
    expect((await human.patch(`/api/items/${id}`, { data: { summary: "s" } })).status).toBe(200);
    expect((await human.patch(`/api/items/${id}`, { data: { fleet: "gone", summary: "t" } })).status).toBe(200);
    expect((await human.patch(`/api/items/${id}`, { data: { fleet: "fa" } })).body.data.fleet).toBe("fa");
  });

  it("aren't checked for a token's own fleet", async () => {
    // A token bound to a fleet nobody registered (only SQL makes one) keeps working in it.
    const t = await mintFleetToken("default");
    await env.DB.prepare("UPDATE tokens SET fleet = 'unlisted' WHERE id = ?").bind(t.token.id).run();
    const U = agent(t.secret);
    expect((await U.get("/api/lease")).status).toBe(200);
    expect((await U.put("/api/meta/manager", { data: { note: "n" } })).body.id).toBe("manager:unlisted");
    expect((await U.put(`/api/items/${uid("u")}`, { data: { type: "info", title: "t" } })).body.data.fleet).toBe("unlisted");
  });
});

describe("people's fleets map", () => {
  it("lists default and every registered fleet with its own status, lease and hours; tokens get none", async () => {
    await human.put("/api/fleets/fb", { data: { label: "Fleet B", color: "#123456" } });
    await human.post("/api/lease/acquire?fleet=fb", { session_id: "fb-s" });
    await human.post("/api/meta/manager/tick-request", { fleet: "fb" });
    const s = (await human.get("/api/state")).body as StateResponse;
    expect(Object.keys(s.fleets!)).toEqual(expect.arrayContaining(["default", "fa", "fb"]));
    const fb = s.fleets!.fb;
    expect(fb.doc?.data).toEqual({ label: "Fleet B", color: "#123456" });
    expect(fb.lease?.id).toBe("lease:fb");
    expect(fb.manager?.id).toBe("manager:fb");
    expect(fb.schedule.inherited).toBe(true);
    expect(s.fleets!.default.manager?.id ?? null).toBe(s.manager?.id ?? null);
    expect(s.fleets!.default.lease).toEqual(s.lease);
    // A meta doc of a fleet that isn't registered doesn't make an entry.
    expect(s.fleets).not.toHaveProperty("unlisted");
    for (const t of [A, D, M]) expect((await t.get("/api/state")).body).not.toHaveProperty("fleets");
  });

  it("comes in a person's delta for the fleets that changed, and never in a token's", async () => {
    const cursor = (await human.get("/api/state")).body.cursor;
    const aCursor = (await A.get("/api/state")).body.cursor;
    await human.patch("/api/fleets/fb", { data: { label: "B2" } });
    const d = (await human.get(`/api/state/delta?since=${cursor}`)).body;
    expect(Object.keys(d.fleets)).toEqual(["fb"]);
    expect(d.fleets.fb.doc.data.label).toBe("B2");
    // The deployment's hours reach every fleet (those without their own inherit them).
    const c2 = d.cursor;
    const sched = (await human.get("/api/schedule")).body.schedule;
    await human.put("/api/schedule", { schedule: { ...sched, sweep_interval_min: sched.sweep_interval_min === 30 ? 45 : 30 } });
    const d2 = (await human.get(`/api/state/delta?since=${c2}`)).body;
    expect(Object.keys(d2.fleets)).toEqual(expect.arrayContaining(["default", "fa", "fb"]));
    // An item change alone brings no map.
    const c3 = d2.cursor;
    await createItem(uid("i"));
    expect((await human.get(`/api/state/delta?since=${c3}`)).body).not.toHaveProperty("fleets");
    expect((await A.get(`/api/state/delta?since=${aCursor}`)).body).not.toHaveProperty("fleets");
  });
});
