// Each fleet's own lease, status (meta/manager) and work hours (docs/api.md "Fleets"). A named fleet's token uses
// the same calls and bare ids as before fleets and reaches its own fleet's copies; people name a fleet; the
// default fleet keeps meta/lease, meta/manager and meta/schedule.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { LEASE_SESSION_HEADER, type StateResponse } from "../../shared/types.ts";
import { applyDelta, normalize } from "./delta-merge.ts";
import { agent, call, human, mintFleetToken, person, setRoles, uid } from "./helpers.ts";

type Client = ReturnType<typeof agent>;
let A: Client, B: Client, D: Client; // orchestrator tokens of fleets fa and fb, and of the default fleet
let aSecret: string;
const cursorNow = async () => (await human.get("/api/changes")).body.cursor as number;
const metaIds = async () =>
  (await env.DB.prepare("SELECT id FROM docs WHERE collection = 'meta' ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);

beforeAll(async () => {
  await setRoles({ "you@test": "admin" });
  aSecret = (await mintFleetToken("fa")).secret;
  A = agent(aSecret);
  B = agent((await mintFleetToken("fb")).secret);
  D = agent((await mintFleetToken(null)).secret);
});

describe("leases", () => {
  it("two fleets' orchestrators hold their own leases at once, and the default fleet's stays meta/lease", async () => {
    const a = await A.post("/api/lease/acquire", { session_id: "sa" });
    const b = await B.post("/api/lease/acquire", { session_id: "sb" });
    const d = await D.post("/api/lease/acquire", { session_id: "sd", force: true, if_version: (await D.get("/api/lease")).body.lease?.version ?? 0 });
    expect([a.status, b.status, d.status]).toEqual([200, 200, 200]);
    expect([a.body.lease.id, b.body.lease.id, d.body.lease.id]).toEqual(["lease:fa", "lease:fb", "lease"]);
    expect((await A.get("/api/lease")).body.lease.data.holder_session_id).toBe("sa");
    expect((await B.get("/api/lease")).body.lease.data.holder_session_id).toBe("sb");
    // A second session of fleet fa contends for fa's lease only.
    expect((await A.post("/api/lease/acquire", { session_id: "sa2" })).status).toBe(409);
    expect((await A.post("/api/lease/renew", { session_id: "sb" })).status).toBe(409);
    expect((await B.post("/api/lease/renew", { session_id: "sb" })).status).toBe(200);
    expect((await B.post("/api/lease/release", { session_id: "sb" })).status).toBe(200);
    expect((await A.get("/api/lease")).body.lease.data.holder_session_id).toBe("sa");
    expect((await B.get("/api/lease")).body.lease).toBeNull();
  });

  it("people read and write a named fleet's lease with ?fleet=, and the default fleet's without", async () => {
    await A.post("/api/lease/acquire", { session_id: "sa-p" , force: true, if_version: (await A.get("/api/lease")).body.lease?.version ?? 0 });
    expect((await human.get("/api/lease?fleet=fa")).body.lease.data.holder_session_id).toBe("sa-p");
    expect((await human.get("/api/lease")).body.lease?.id ?? "lease").toBe("lease");
    expect((await human.post("/api/lease/release?fleet=fa", { session_id: "sa-p" })).status).toBe(200);
    expect((await A.get("/api/lease")).body.lease).toBeNull();
    expect((await human.get("/api/lease?fleet=Bad")).status).toBe(400);
  });

  it("a token that names another fleet is 403", async () => {
    expect((await A.get("/api/lease?fleet=fb")).status).toBe(403);
    expect((await A.post("/api/lease/acquire?fleet=fb", { session_id: "x" })).status).toBe(403);
    expect((await D.get("/api/lease?fleet=fa")).status).toBe(403);
    expect((await A.get("/api/lease?fleet=fa")).status).toBe(200);
  });

  it("X-Lease-Session checks the token's own fleet's lease", async () => {
    const v = (await A.get("/api/lease")).body.lease?.version ?? 0;
    expect((await A.post("/api/lease/acquire", { session_id: "sa-h", force: true, if_version: v })).status).toBe(200);
    const write = (session: string) =>
      call("PUT", `/agent/api/items/${uid("hdr")}`, {
        token: aSecret,
        host: "inbox.test",
        headers: { [LEASE_SESSION_HEADER]: session },
        body: { data: { type: "info", title: "x" } },
      });
    expect((await write("sa-h")).status).toBe(201);
    // Fleet fb's lease, or the default fleet's, held by that session, isn't fa's.
    await B.post("/api/lease/acquire", { session_id: "sb-h" });
    const r = await write("sb-h");
    expect(r.status).toBe(409);
    expect(r.body.current.id).toBe("lease:fa");
  });

  it("takes its default TTL from the fleet's own hours", async () => {
    const sched = (await human.get("/api/schedule")).body.schedule;
    expect((await B.put("/api/schedule", { schedule: { ...sched, pickup_interval_min: 120, sweep_interval_min: 120 } })).status).toBe(200);
    const v = (await B.get("/api/lease")).body.lease?.version ?? 0;
    const r = await B.post("/api/lease/acquire", { session_id: "sb-ttl", force: true, if_version: v });
    const ttl = (Date.parse(r.body.lease.data.expires_at) - Date.parse(r.body.lease.data.heartbeat_at)) / 60_000;
    expect(ttl).toBe(135);
    await B.del("/api/schedule");
  });
});

describe("status and tick requests", () => {
  it("keeps each fleet's meta/manager apart: patch, batch digest and tick request", async () => {
    expect((await A.put("/api/meta/manager", { data: { digest: "fa digest" } })).body.id).toBe("manager:fa");
    expect((await B.patch("/api/meta/manager", { data: { digest: "fb digest" } })).status).toBe(404);
    expect((await B.post("/api/batch", { ops: [{ op: "meta.put", id: "manager", data: { digest: "fb digest" } }] })).body.results[0].id).toBe("manager:fb");
    expect((await A.get("/api/meta/manager")).body.data.digest).toBe("fa digest");
    expect((await A.get("/api/meta/manager:fa")).body.data.digest).toBe("fa digest");
    expect((await B.get("/api/meta/manager")).body.data.digest).toBe("fb digest");
    const tick = await A.post("/api/meta/manager/tick-request", { note: "now" });
    expect([tick.body.id, tick.body.data.tick_requested_note]).toEqual(["manager:fa", "now"]);
    expect((await B.get("/api/meta/manager")).body.data).not.toHaveProperty("tick_requested_at");
    // People name the fleet in the body; without one it is the default fleet's.
    expect((await human.post("/api/meta/manager/tick-request", { fleet: "fb" })).body.id).toBe("manager:fb");
    expect((await human.post("/api/meta/manager/tick-request", {})).body.id).toBe("manager");
    expect((await A.post("/api/meta/manager/tick-request", { fleet: "fb" })).status).toBe(403);
  });

  it("shows each token its own fleet's manager, lease and schedule in /api/state and the delta", async () => {
    const c0 = await cursorNow();
    await A.patch("/api/meta/manager", { data: { last_tick: "t1" } });
    await B.patch("/api/meta/manager", { data: { last_tick: "t2" } });
    const sa = (await A.get("/api/state")).body, sb = (await B.get("/api/state")).body;
    expect([sa.manager.id, sb.manager.id]).toEqual(["manager:fa", "manager:fb"]);
    expect((await human.get("/api/state")).body.manager?.id ?? "manager").toBe("manager");
    const da = (await A.get(`/api/state/delta?since=${c0}`)).body;
    expect(da.manager).toEqual(sa.manager);
    const dd = (await D.get(`/api/state/delta?since=${c0}`)).body;
    expect(dd).not.toHaveProperty("manager");
    expect((await human.get(`/api/state/delta?since=${c0}`)).body).not.toHaveProperty("manager");
  });

  it("wakes only its own fleet's feed on a status write", async () => {
    const c0 = await cursorNow();
    await B.patch("/api/meta/manager", { data: { last_tick: "t3" } });
    expect((await A.get(`/api/changes?since=${c0}`)).body.changes).toEqual([]);
    expect((await D.get(`/api/changes?since=${c0}`)).body.changes).toEqual([]);
    expect((await B.get(`/api/changes?since=${c0}`)).body.changes.map((r: any) => r.doc_id)).toEqual(["manager:fb"]);
    // The default fleet's own status and lease don't reach a named fleet either.
    const c1 = await cursorNow();
    await D.patch("/api/meta/manager", { data: { last_tick: "t4" } }).then((r) => (r.status === 404 ? D.put("/api/meta/manager", { data: { last_tick: "t4" } }) : r));
    expect((await A.get(`/api/changes?since=${c1}`)).body.changes).toEqual([]);
  });
});

describe("work hours", () => {
  it("a named fleet uses the deployment's hours until it sets its own, and again after it drops them", async () => {
    const shared = (await human.get("/api/schedule")).body;
    const fa = (await A.get("/api/schedule")).body;
    expect(fa).toMatchObject({ schedule: shared.schedule, version: null, inherited: true });
    expect((await human.get("/api/schedule?fleet=fa")).body).toMatchObject({ schedule: fa.schedule, version: null, inherited: true });
    const own = { ...shared.schedule, work_hours: "06:00-10:00 Mon-Fri" };
    const put = await A.put("/api/schedule", { schedule: own, if_version: 0 });
    expect(put.status).toBe(200);
    expect(put.body).not.toHaveProperty("inherited");
    expect(put.body.schedule.work_hours).toBe("06:00-10:00 Mon-Fri");
    expect((await human.get("/api/schedule")).body.schedule.work_hours).toBe(shared.schedule.work_hours);
    expect((await B.get("/api/schedule")).body.inherited).toBe(true);
    expect((await A.get("/api/state")).body.schedule.schedule.work_hours).toBe("06:00-10:00 Mon-Fri");
    // Dropping its own hours: back to the deployment's.
    const del = await A.del("/api/schedule");
    expect([del.status, del.body.inherited]).toEqual([200, true]);
    expect((await A.get("/api/schedule")).body.schedule).toEqual(shared.schedule);
    expect((await D.del("/api/schedule")).status).toBe(400);
    expect((await human.del("/api/schedule")).status).toBe(400);
  });

  it("follows a change to the deployment's hours while it inherits them, in its delta too", async () => {
    const shared = (await human.get("/api/schedule")).body;
    const c0 = await cursorNow();
    const next = { ...shared.schedule, sweep_interval_min: shared.schedule.sweep_interval_min === 45 ? 50 : 45 };
    expect((await human.put("/api/schedule", { schedule: next })).status).toBe(200);
    const d = (await A.get(`/api/state/delta?since=${c0}`)).body;
    expect(d.schedule).toMatchObject({ schedule: next, inherited: true, version: null });
  });

  it("people set and drop a named fleet's hours with ?fleet=; a token can't touch another fleet's", async () => {
    const shared = (await human.get("/api/schedule")).body.schedule;
    expect((await human.put("/api/schedule?fleet=fb", { schedule: { ...shared, pickup_interval_min: 30 } })).status).toBe(200);
    expect((await B.get("/api/schedule")).body.schedule.pickup_interval_min).toBe(30);
    expect((await A.put("/api/schedule?fleet=fb", { schedule: shared })).status).toBe(403);
    expect((await A.get("/api/schedule?fleet=fb")).status).toBe(403);
    expect((await human.del("/api/schedule?fleet=fb")).body.inherited).toBe(true);
    expect(await metaIds()).not.toContain("schedule:fb");
  });
});

describe("a named fleet's lease in claims, batches and renewals", () => {
  const withSession = (session: string) => ({ token: aSecret, host: "inbox.test", headers: { [LEASE_SESSION_HEADER]: session } });
  const takeA = async (session: string) => {
    const v = (await A.get("/api/lease")).body.lease?.version ?? 0;
    expect((await A.post("/api/lease/acquire", { session_id: session, force: true, if_version: v })).status).toBe(200);
  };

  it("lets the session holding the fleet's lease re-take an item another session left processing", async () => {
    const id = uid("retake");
    await A.put(`/api/items/${id}`, { data: { type: "decision", title: "r" } });
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    await takeA("fa-s1");
    const first = await call("POST", `/agent/api/items/${id}/claim`, { ...withSession("fa-s1"), body: {} });
    expect([first.status, first.body.data.claimed_by]).toEqual([200, "fa-s1"]);
    await takeA("fa-s2");
    const again = await call("POST", `/agent/api/items/${id}/claim`, { ...withSession("fa-s2"), body: {} });
    expect([again.status, again.body.data.claimed_by, again.body.data.reclaimed_from]).toEqual([200, "fa-s2", "fa-s1"]);
    // The old session lost fa's lease: its write is refused with fa's lease as current.
    const stale = await call("POST", `/agent/api/items/${id}/claim`, { ...withSession("fa-s1"), body: {} });
    expect([stale.status, stale.body.current?.id]).toEqual([409, "lease:fa"]);
  });

  it("checks a batch's X-Lease-Session against the fleet's lease", async () => {
    await takeA("fa-batch");
    const ops = { ops: [{ op: "item.put", id: uid("fa-b"), data: { type: "info", title: "b" } }] };
    expect((await call("POST", "/agent/api/batch", { ...withSession("fa-batch"), body: ops })).status).toBe(200);
    await B.post("/api/lease/acquire", { session_id: "fb-batch", force: true, if_version: (await B.get("/api/lease")).body.lease?.version ?? 0 });
    const r = await call("POST", "/agent/api/batch", { ...withSession("fb-batch"), body: { ops: [{ op: "item.put", id: uid("fa-b"), data: { type: "info", title: "b" } }] } });
    expect([r.status, r.body.current?.id]).toEqual([409, "lease:fa"]);
  });

  it("renews for the fleet's own hours' TTL", async () => {
    const sched = (await human.get("/api/schedule")).body.schedule;
    await A.put("/api/schedule", { schedule: { ...sched, pickup_interval_min: 60, sweep_interval_min: 60 } });
    await takeA("fa-renew");
    const r = await A.post("/api/lease/renew", { session_id: "fa-renew" });
    expect((Date.parse(r.body.lease.data.expires_at) - Date.parse(r.body.lease.data.heartbeat_at)) / 60_000).toBe(75);
    await A.del("/api/schedule");
  });
});

describe("default and invalid fleet names", () => {
  it("?fleet=default and fleet: default are the default fleet's; a meta id must name a fleet id", async () => {
    expect((await human.post("/api/meta/manager/tick-request", { fleet: "default" })).body.id).toBe("manager");
    const d = await human.post("/api/lease/acquire?fleet=default", { session_id: uid("def"), force: true, if_version: (await human.get("/api/lease")).body.lease?.version ?? 0 });
    expect(d.body.lease.id).toBe("lease");
    expect((await human.put("/api/meta/schedule:Bad_Fleet", { data: {} })).status).toBe(400);
    expect((await human.put("/api/meta/manager:Bad_Fleet", { data: {} })).status).toBe(400);
    expect((await A.post("/api/lease/release?fleet=fb", {})).status).toBe(403); // the fleet before the body
    expect((await A.put("/api/schedule?fleet=fb", {})).status).toBe(403);
  });
});

describe("dropping a fleet's own hours", () => {
  it("is pinned with if_version, idempotent, and an admin's or the fleet orchestrator's only", async () => {
    const sched = (await human.get("/api/schedule")).body.schedule;
    const put = await A.put("/api/schedule", { schedule: { ...sched, pickup_interval_min: 20 } });
    expect((await A.del(`/api/schedule?if_version=${put.body.version + 1}`)).status).toBe(409);
    await setRoles({ "viewer@team.test": "viewer" });
    expect((await person("viewer@team.test").del("/api/schedule?fleet=fa")).status).toBe(403);
    const mgr = agent((await mintFleetToken("fa", "orchestrator", uid("I"))).secret);
    expect((await mgr.del("/api/schedule")).status).toBe(403);
    expect((await A.del(`/api/schedule?if_version=${put.body.version}`)).body.inherited).toBe(true);
    expect((await A.del("/api/schedule")).status).toBe(200);
  });

  it("says when the inherited hours change (inherited_version)", async () => {
    const before = (await A.get("/api/schedule")).body;
    const shared = (await human.get("/api/schedule")).body;
    expect(before.inherited_version).toBe(shared.version);
    const next = { ...shared.schedule, sweep_interval_min: shared.schedule.sweep_interval_min === 40 ? 41 : 40 };
    const r = await human.put("/api/schedule", { schedule: next });
    expect((await A.get("/api/schedule")).body).toMatchObject({ version: null, inherited: true, inherited_version: r.body.version });
  });
});

describe("a named fleet's manager token", () => {
  it("follows its fleet's hours in /api/state and the delta: own, dropped, and the deployment's", async () => {
    const mgr = agent((await mintFleetToken("fa", "orchestrator", uid("I"))).secret);
    let held = (await mgr.get("/api/state")).body as StateResponse;
    const step = async (write: () => Promise<unknown>) => {
      await write();
      const d = (await mgr.get(`/api/state/delta?since=${held.cursor}`)).body;
      expect(d).not.toHaveProperty("manager");
      expect(d).not.toHaveProperty("lease");
      held = applyDelta(held, d);
      expect(normalize(held)).toEqual(normalize((await mgr.get("/api/state")).body));
    };
    const shared = (await human.get("/api/schedule")).body.schedule;
    await step(() => A.put("/api/schedule", { schedule: { ...shared, pickup_interval_min: 15 } }));
    expect(held.schedule.schedule.pickup_interval_min).toBe(15);
    await step(() => A.del("/api/schedule"));
    expect(held.schedule.inherited).toBe(true);
    await step(() => human.put("/api/schedule", { schedule: { ...shared, sweep_interval_min: shared.sweep_interval_min === 44 ? 46 : 44 } }));
    await step(() => A.put("/api/meta/manager", { data: { note: uid() } }));
  });
});
