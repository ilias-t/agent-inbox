// GET /api/state/delta?since=<cursor>: what changed in /api/state since a cursor, so an open page merges a
// few docs instead of refetching the whole snapshot on every change.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { StateResponse } from "../../shared/types.ts";
import { DELTA_MAX_CHANGES } from "../../worker/routes/delta.ts";
import { applyDelta, normalize, rng } from "./delta-merge.ts";
import { agent, createItem, human, mintFleetToken, mintToken, person, setRoles, uid } from "./helpers.ts";
import { reportOf, routine, stamp } from "./reviews-helpers.ts";

const cursorNow = async () => (await human.get("/api/changes")).body.cursor as number;
// Far enough that no snooze runs out during the run (it would leave /api/state with no change row).
const FAR = new Date(Date.now() + 7 * 86_400_000).toISOString();
const A = person("a@team.test"), B = person("b@team.test");

// Everyone used below keeps the role the test needs (you@test is the DEV_NO_ACCESS human).
beforeAll(async () => {
  await setRoles({ "you@test": "admin", "a@team.test": "decider", "b@team.test": "decider" });
});

describe("GET /api/state/delta", () => {
  it("returns the current version of an item created since the cursor, and the new cursor", async () => {
    const c0 = await cursorNow();
    const id = uid("d");
    await createItem(id);
    const r = await human.get(`/api/state/delta?since=${c0}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doc = (await human.get(`/api/items/${id}`)).body;
    expect(r.body.cursor).toBe(await cursorNow());
    expect(r.body.items).toEqual([doc]);
    expect(r.body.deleted).toEqual([]);
    expect(r.body.orchestrators).toEqual([]);
    expect(r.body.qa_changed).toEqual([]);
    expect(r.body).not.toHaveProperty("people");
    expect(r.body).not.toHaveProperty("snoozes");
    expect(r.body).not.toHaveProperty("manager");
    expect(r.body).not.toHaveProperty("reset");
  });

  it("is empty at the current cursor", async () => {
    await createItem(uid("d"));
    const c = await cursorNow();
    const r = await human.get(`/api/state/delta?since=${c}`);
    expect(r.body).toMatchObject({ cursor: c, items: [], deleted: [], orchestrators: [], qa_changed: [] });
  });

  it("requires a non-negative integer since", async () => {
    expect((await human.get("/api/state/delta")).status).toBe(400);
    expect((await human.get("/api/state/delta?since=abc")).status).toBe(400);
    expect((await human.get("/api/state/delta?since=-1")).status).toBe(400);
  });

  it("sends an item written several times once, at its latest version, and counts archived items", async () => {
    const c0 = await cursorNow();
    const id = uid("d");
    await createItem(id);
    await human.patch(`/api/items/${id}`, { data: { summary: "two" } });
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    await human.post(`/api/items/${id}/archive`);
    const r = await human.get(`/api/state/delta?since=${c0}`);
    expect(r.body.items).toEqual([(await human.get(`/api/items/${id}`)).body]);
    expect(r.body.items[0].data.status).toBe("archived");
    expect(r.body.archived_total).toBe((await human.get("/api/state")).body.archived_total);
  });

  it("recounts archived items only when an item may have entered or left the archive", async () => {
    const id = uid("d"), fresh = uid("d");
    await createItem(id);
    const c0 = await cursorNow();
    await human.patch(`/api/items/${id}`, { data: { summary: "edit" } });
    await human.post(`/api/items/${id}/decide`, { choice: "ack" });
    await createItem(fresh); // created inside the window, open
    expect((await human.get(`/api/state/delta?since=${c0}`)).body).not.toHaveProperty("archived_total");
    const c1 = await cursorNow();
    await human.post(`/api/items/${id}/archive`);
    const total = (await human.get("/api/state")).body.archived_total;
    expect((await human.get(`/api/state/delta?since=${c1}`)).body.archived_total).toBe(total);
    const c2 = await cursorNow();
    await human.del(`/api/items/${id}`);
    expect((await human.get(`/api/state/delta?since=${c2}`)).body.archived_total).toBe(total - 1);
  });

  it("recounts when an item's history before the cursor was pruned", async () => {
    const id = uid("d");
    await createItem(id);
    const c0 = await cursorNow();
    await env.DB.prepare("DELETE FROM changes WHERE collection = 'items' AND doc_id = ? AND seq <= ?").bind(id, c0).run();
    await human.patch(`/api/items/${id}`, { data: { summary: "edit" } });
    expect((await human.get(`/api/state/delta?since=${c0}`)).body.archived_total).toBe(
      (await human.get("/api/state")).body.archived_total,
    );
  });

  it("reports deleted items and orchestrators, and the qa threads that changed", async () => {
    const id = uid("d"), o = uid("O"), brief = uid("d");
    await createItem(id);
    await human.put(`/api/orchestrators/${o}`, { data: {} });
    const c0 = await cursorNow();
    await human.post(`/api/items/${id}/qa`, { text: "why?" });
    await human.del(`/api/items/${id}`);
    await human.del(`/api/orchestrators/${o}`);
    await createItem(brief);
    await human.del(`/api/items/${brief}`); // created and gone inside the window
    const r = await human.get(`/api/state/delta?since=${c0}`);
    expect(r.body.items).toEqual([]);
    expect(r.body.orchestrators).toEqual([]);
    expect(r.body.deleted).toEqual(
      expect.arrayContaining([
        { collection: "items", id },
        { collection: "items", id: brief },
        { collection: "orchestrators", id: o },
      ]),
    );
    expect(r.body.deleted).toHaveLength(3);
    expect(r.body.qa_changed).toEqual([id]);
  });

  it("names an item whose qa changed without sending the thread", async () => {
    const id = uid("d");
    await createItem(id);
    const c0 = await cursorNow();
    await human.post(`/api/items/${id}/qa`, { text: "q" });
    const r = await human.get(`/api/state/delta?since=${c0}`);
    expect(r.body.qa_changed).toEqual([id]);
    // Posting a question also bumps the item (qa_pending), which comes as an item.
    expect(r.body.items.map((d: any) => d.id)).toEqual([id]);
  });

  describe("meta", () => {
    it("sends manager, lease and the schedule view only when they changed; a deleted one as null", async () => {
      const c0 = await cursorNow();
      expect((await human.put("/api/meta/manager", { data: { note: "hi" } })).status).toBeLessThan(300);
      const r1 = await human.get(`/api/state/delta?since=${c0}`);
      expect(r1.body.manager).toEqual((await human.get("/api/meta/manager")).body);
      expect(r1.body).not.toHaveProperty("lease");
      expect(r1.body).not.toHaveProperty("schedule");

      const c1 = r1.body.cursor;
      expect((await human.post("/api/lease/acquire", { session_id: "s1" })).status).toBe(200);
      const sched = (await human.get("/api/schedule")).body;
      expect((await human.put("/api/schedule", { schedule: { ...sched.schedule, pickup_interval_min: 15 } })).status).toBe(200);
      const r2 = await human.get(`/api/state/delta?since=${c1}`);
      expect(r2.body).not.toHaveProperty("manager");
      expect(r2.body.lease).toEqual((await human.get("/api/lease")).body.lease);
      expect(r2.body.schedule.schedule.pickup_interval_min).toBe(15);
      expect(r2.body.schedule.computed).toBeDefined();

      const c2 = r2.body.cursor;
      await env.DB.prepare("DELETE FROM docs WHERE collection = 'meta' AND id = 'manager'").run();
      const r3 = await human.get(`/api/state/delta?since=${c2}`);
      expect(r3.body.manager).toBeNull();
    });

    it("ignores meta docs that aren't part of /api/state", async () => {
      const c0 = await cursorNow();
      expect((await human.put("/api/meta/other", { data: { x: 1 } })).status).toBeLessThan(300);
      const r = await human.get(`/api/state/delta?since=${c0}`);
      expect(r.body).not.toHaveProperty("manager");
      expect(r.body).not.toHaveProperty("lease");
      expect(r.body).not.toHaveProperty("schedule");
    });
  });

  describe("people and roles", () => {
    it("sends people and the caller's current role when a users row changed", async () => {
      const C = person("c@team.test");
      await setRoles({ "c@team.test": "decider" });
      const c0 = await cursorNow();
      expect((await human.put("/api/users/c@team.test", { role: "viewer" })).status).toBe(200);
      const r = await C.get(`/api/state/delta?since=${c0}`);
      expect(r.body.me).toMatchObject({ kind: "human", email: "c@team.test", role: "viewer" });
      expect(r.body.people).toEqual((await C.get("/api/state")).body.people);
      expect(r.body.people.map((p: any) => p.email)).toContain("c@team.test");
    });

    it("sends a name change as people", async () => {
      const c0 = await cursorNow();
      expect((await A.put("/api/people/me", { name: "Ada" })).status).toBe(200);
      const r = await B.get(`/api/state/delta?since=${c0}`);
      expect(r.body.people).toContainEqual(expect.objectContaining({ email: "a@team.test", name: "Ada" }));
    });
  });

  describe("snoozes", () => {
    it("sends the snoozer's whole map, and nothing about it to anyone else", async () => {
      const id = uid("snz"), other = uid("snz");
      await createItem(id);
      await createItem(other);
      expect((await A.post(`/api/items/${other}/snooze`, { until: FAR })).status).toBe(200);
      const c0 = await cursorNow();
      expect((await A.post(`/api/items/${id}/snooze`, { until: FAR })).status).toBe(200);
      const mgr = agent((await mintToken("manager")).secret);

      const a = await A.get(`/api/state/delta?since=${c0}`);
      expect(a.body.snoozes).toEqual((await A.get("/api/state")).body.snoozes);
      expect(a.body.snoozes).toMatchObject({ [id]: FAR, [other]: FAR });
      expect(a.body.items).toEqual([]); // the item doc isn't written
      const b = await B.get(`/api/state/delta?since=${c0}`);
      expect(b.body).not.toHaveProperty("snoozes");
      expect((await mgr.get(`/api/state/delta?since=${c0}`)).body).not.toHaveProperty("snoozes");
    });

    it("sends an empty map when the last snooze goes", async () => {
      const C = person("snoozer@team.test");
      await setRoles({ "snoozer@team.test": "decider" });
      const id = uid("snz");
      await createItem(id);
      expect((await C.post(`/api/items/${id}/snooze`, { until: FAR })).status).toBe(200);
      const c0 = await cursorNow();
      expect((await C.post(`/api/items/${id}/snooze`, { until: null })).status).toBe(200);
      expect((await C.get(`/api/state/delta?since=${c0}`)).body.snoozes).toEqual({});
    });
  });

  describe("orchestrator tokens", () => {
    it("see only their own items and orchestrator doc, the schedule, and never meta or people", async () => {
      const o = uid("O");
      const orch = agent((await mintToken("orchestrator", o)).secret);
      const c0 = await cursorNow();
      const mine = uid("mine"), theirs = uid("theirs");
      await createItem(mine, { orchestrator: o });
      await createItem(theirs, { orchestrator: "O-other" });
      await human.post(`/api/items/${theirs}/qa`, { text: "q" });
      await human.put(`/api/orchestrators/${o}`, { data: {} });
      await human.put("/api/orchestrators/O-other", { data: {} });
      await human.del(`/api/items/${theirs}`);
      await human.put("/api/meta/manager", { data: { note: uid() } });
      await human.put("/api/users/someone@team.test", { role: "viewer" });
      const sched = (await human.get("/api/schedule")).body;
      await human.put("/api/schedule", { schedule: { ...sched.schedule, sweep_interval_min: 45 } });

      const r = await orch.get(`/api/state/delta?since=${c0}`);
      expect(r.status).toBe(200);
      expect(r.body.items.map((d: any) => d.id)).toEqual([mine]);
      expect(r.body.orchestrators.map((d: any) => d.id)).toEqual([o]);
      expect(r.body.deleted).toEqual([]);
      expect(r.body.qa_changed).toEqual([]);
      expect(r.body).not.toHaveProperty("manager");
      expect(r.body).not.toHaveProperty("people");
      expect(r.body.schedule.schedule.sweep_interval_min).toBe(45);
      expect(r.body.archived_total).toBe((await orch.get("/api/state")).body.archived_total);
    });

    it("lose an item reassigned to another orchestrator, as a delete, without seeing it", async () => {
      const o = uid("O"), o2 = uid("O");
      const orch = agent((await mintToken("orchestrator", o)).secret);
      const orch2 = agent((await mintToken("orchestrator", o2)).secret);
      const moved = uid("moved");
      await createItem(moved, { orchestrator: o }); // before the cursor
      const c0 = await cursorNow();
      await human.patch(`/api/items/${moved}`, { data: { orchestrator: o2 } });
      await human.patch(`/api/items/${moved}`, { data: { summary: "secret" } });

      const r = await orch.get(`/api/state/delta?since=${c0}`);
      expect(r.body.items).toEqual([]);
      expect(r.body.deleted).toEqual([{ collection: "items", id: moved }]);
      expect(JSON.stringify(r.body)).not.toContain("secret");
      const r2 = await orch2.get(`/api/state/delta?since=${c0}`);
      expect(r2.body.items.map((d: any) => d.id)).toEqual([moved]);
    });
  });

  describe("reviews", () => {
    it("names the routines whose data changed and sends the routines list, only then", async () => {
      const r = await routine("dr");
      const c0 = await cursorNow();
      await r.report({ stamp: stamp(0), report: reportOf([1, 2]) });
      const d = await human.get(`/api/state/delta?since=${c0}`);
      expect(d.body.reviews_changed).toEqual([r.id]);
      expect(d.body.routines).toEqual((await human.get("/api/state")).body.routines);
      expect(d.body.items).toEqual([]);
      const c1 = d.body.cursor;
      await createItem(uid("d"));
      const quiet = await human.get(`/api/state/delta?since=${c1}`);
      expect(quiet.body).not.toHaveProperty("reviews_changed");
      expect(quiet.body).not.toHaveProperty("routines");
    });

    it("an orchestrator token hears only about its own routine", async () => {
      const r = await routine("dr-own"), other = await routine("dr-other");
      const c0 = await cursorNow();
      await other.report({ stamp: stamp(0), report: reportOf([1]) });
      expect((await r.client.get(`/api/state/delta?since=${c0}`)).body).not.toHaveProperty("reviews_changed");
      await r.start(stamp(0));
      const d = await r.client.get(`/api/state/delta?since=${c0}`);
      expect(d.body.reviews_changed).toEqual([r.id]);
      expect(d.body.routines.map((x: { id: string }) => x.id)).toEqual([r.id]);
    });

    it("a deleted routine is named and gone from the list", async () => {
      const r = await routine("dr-del");
      await r.report({ stamp: stamp(0), report: reportOf([1]) });
      const c0 = await cursorNow();
      expect((await human.del(`/api/reviews/${r.id}`)).status).toBe(200);
      const d = await human.get(`/api/state/delta?since=${c0}`);
      expect(d.body.reviews_changed).toEqual([r.id]);
      expect(d.body.routines.map((x: { id: string }) => x.id)).not.toContain(r.id);
    });
  });

  describe("reset", () => {
    it("asks for a full fetch when changes after the cursor were pruned", async () => {
      const c0 = await cursorNow();
      await createItem(uid("d"));
      await createItem(uid("d"));
      await createItem(uid("d"));
      // The cron prunes oldest first and always keeps the newest.
      await env.DB.prepare("DELETE FROM changes WHERE seq = ?").bind(c0 + 1).run();
      expect((await human.get(`/api/state/delta?since=${c0}`)).body).toEqual({ reset: true });
      // A cursor past the pruned row still works.
      expect((await human.get(`/api/state/delta?since=${c0 + 1}`)).body.items).toHaveLength(2);
    });

    it("asks for a full fetch when a change in the middle is gone", async () => {
      const c0 = await cursorNow();
      await createItem(uid("d"));
      await createItem(uid("d"));
      await createItem(uid("d"));
      await env.DB.prepare("DELETE FROM changes WHERE seq = ?").bind(c0 + 2).run();
      expect((await human.get(`/api/state/delta?since=${c0}`)).body).toEqual({ reset: true });
      expect((await human.get(`/api/state/delta?since=${c0 + 2}`)).body.items).toHaveLength(1);
    });

    it(`asks for a full fetch past ${DELTA_MAX_CHANGES} changes, not at it`, async () => {
      const c0 = await cursorNow();
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
         SELECT 'meta', 'filler', 'update', 1, NULL, 'test', '2030-01-01T00:00:00.000Z' FROM n`,
      )
        .bind(DELTA_MAX_CHANGES)
        .run();
      const at = await human.get(`/api/state/delta?since=${c0}`);
      expect(at.body).not.toHaveProperty("reset");
      expect(at.body.cursor).toBe(c0 + DELTA_MAX_CHANGES);
      await createItem(uid("d"));
      expect((await human.get(`/api/state/delta?since=${c0}`)).body).toEqual({ reset: true });
      expect((await human.get(`/api/state/delta?since=${c0 + 1}`)).body.items).toHaveLength(1);
    });

    it("asks for a full fetch for a cursor from the future (another database)", async () => {
      const c = await cursorNow();
      expect((await human.get(`/api/state/delta?since=${c + 1}`)).body).toEqual({ reset: true });
    });
  });

  // The property the client relies on: a snapshot with every delta since applied equals a fresh snapshot, for
  // every kind of caller, over a random (seeded) run of writes. Its time is HTTP round trips through workerd and D1
  // (the data stays a handful of docs), so each op is one request and each kind gets a fixed number of turns.
  // Each op kind ROUNDS times (creates twice), a delta and a fresh snapshot per pull, and the setup come to about 180
  // requests in sequence: about 1 s on an idle machine, but past vitest's default 5 s when the machine is busy enough
  // to slow it fivefold. 30 s is about 25 times the idle time (the 155-request run took 12 s on a CPU core shared
  // with twelve busy loops).
  it("merged into a /api/state snapshot, equals a fresh /api/state for every caller", { timeout: 30_000 }, async () => {
    const R = rng(20261106);
    const O1 = uid("O1"), O2 = uid("O2");
    // O1's token both views (its scoped state and delta) and reports its own routine; O2 writes a second one.
    const o1 = agent((await mintToken("orchestrator", O1)).secret), o2 = agent((await mintToken("orchestrator", O2)).secret);
    // A second fleet (docs/api.md "Fleets"): its orchestrator token views and posts its own items, and its routine
    // O3 reports; the default fleet's orchestrator token ("manager" below) must see none of it.
    const fa = agent((await mintFleetToken("fa")).secret), O3 = uid("O3");
    const o3 = agent((await mintFleetToken("fa", "orchestrator", O3)).secret);
    const viewers: { name: string; get: (path: string) => Promise<{ status: number; body: any }> }[] = [
      { name: "admin", get: human.get },
      { name: "A", get: A.get },
      { name: "B", get: B.get },
      { name: "manager", get: agent((await mintToken("manager")).secret).get },
      { name: "orch O1", get: o1.get },
      { name: "fleet fa", get: fa.get },
    ];
    const held = new Map<string, StateResponse>();
    for (const v of viewers) held.set(v.name, (await v.get("/api/state")).body);
    // Every caller must merge a delta that updates a doc it held and one that removes a doc it held, or the run
    // never tests its merge on anything but new docs.
    const covered = new Set<string>();
    const pull = async (v: (typeof viewers)[number], step: number) => {
      const before = held.get(v.name)!;
      const d = await v.get(`/api/state/delta?since=${before.cursor}`);
      expect(d.status, `${v.name} step ${step}: ${JSON.stringify(d.body)}`).toBe(200);
      const had = new Set([
        ...before.items.map((x) => `items/${x.id}`),
        ...before.orchestrators.map((x) => `orchestrators/${x.id}`),
      ]);
      for (const c of ["items", "orchestrators"] as const)
        if ((d.body[c] ?? []).some((x: { id: string }) => had.has(`${c}/${x.id}`))) covered.add(`${v.name} updated`);
      if ((d.body.deleted ?? []).some((x: { collection: string; id: string }) => had.has(`${x.collection}/${x.id}`)))
        covered.add(`${v.name} removed`);
      if (d.body.routines) covered.add(`${v.name} routines`);
      if (d.body.pins) covered.add(`${v.name} pins`);
      const merged = applyDelta(before, d.body);
      const fresh = (await v.get("/api/state")).body as StateResponse;
      expect(normalize(merged), `${v.name} after step ${step}`).toEqual(normalize(fresh));
      held.set(v.name, merged);
    };

    const ids: string[] = [];
    const orchs = [O1, O2];
    const live = new Set<string>(); // orchestrator docs that exist, so a delete usually has one to remove
    // Orchestrators take turns rather than being drawn, so each gets its own items and doc written.
    const turns = <T,>(xs: T[]) => {
      let i = 0;
      return () => xs[i++ % xs.length];
    };
    const createFor = turns([O1, O2, undefined]), moveTo = turns([O2, O1]), putOrch = turns([O1, O2]);
    const pinner = turns([A, B, human]), unpinner = turns([A, B, human]);
    const moveFleet = turns(["fa", "default"]);
    // Only the run writes the lease and the schedule, so it keeps their latest copy from its own write results
    // instead of reading them before each write.
    const admin = held.get("admin")!;
    let leaseVersion = admin.lease?.version ?? 0;
    let schedule = admin.schedule.schedule;
    let tick = 0; // run stamps, a minute apart
    const ops: (() => Promise<{ status: number }>)[] = [
      async () => {
        const id = uid("p");
        ids.push(id);
        const orchestrator = createFor();
        return human.put(`/api/items/${id}`, { data: { type: "decision", title: id, ...(orchestrator ? { orchestrator } : {}) } });
      },
      async () => human.patch(`/api/items/${R.pick(ids)}`, { data: { summary: uid("s") } }),
      async () => human.post(`/api/items/${R.pick(ids)}/decide`, { choice: "ack" }),
      async () => human.post(`/api/items/${R.pick(ids)}/archive`),
      async () => {
        const id = R.pick(ids);
        const r = await human.del(`/api/items/${id}`);
        if (r.status < 300) ids.splice(ids.indexOf(id), 1); // later ops pick items that are still there
        return r;
      },
      async () => human.post(`/api/items/${R.pick(ids)}/qa`, { text: "q" }),
      async () => human.patch(`/api/items/${R.pick(ids)}`, { data: { orchestrator: moveTo() } }),
      async () => {
        const o = putOrch();
        const r = await human.put(`/api/orchestrators/${o}`, { data: { note: uid("n") } });
        if (r.status < 300) live.add(o);
        return r;
      },
      async () => {
        const o = R.pick(live.size ? [...live] : orchs);
        const r = await human.del(`/api/orchestrators/${o}`);
        if (r.status < 300) live.delete(o);
        return r;
      },
      async () => human.put("/api/meta/manager", { data: { note: uid("m") } }),
      async () => {
        const r = await human.post("/api/lease/acquire", { session_id: uid("lease"), force: true, if_version: leaseVersion });
        if (r.status < 300) leaseVersion = r.body.lease.version;
        return r;
      },
      async () => {
        const r = await human.put("/api/schedule", { schedule: { ...schedule, pickup_interval_min: R.pick([5, 10, 15, 20, 30]) } });
        if (r.status < 300) schedule = r.body.schedule;
        return r;
      },
      async () => human.put("/api/users/c@team.test", { role: R.pick(["decider", "viewer"]) }),
      async () => R.pick([A, B]).put("/api/people/me", { name: uid("name") }),
      async () => R.pick([A, B]).post(`/api/items/${R.pick(ids)}/snooze`, { until: R.pick([FAR, null]) }),
      // Pins (per person, like snoozes): each human in turn pins an item, then an orchestrator or one of O1's PRs
      // (refused while there is none), and unpins one of those.
      async () => pinner().put(`/api/pins/item/${R.pick(ids)}`, {}),
      async () => pinner().put(`/api/pins/${R.pick([`orch/${R.pick(live.size ? [...live] : orchs)}`, `pr/${O1}/${1 + R.int(2)}`])}`, {}),
      async () => unpinner().del(`/api/pins/${R.pick([`item/${R.pick(ids)}`, `orch/${R.pick(orchs)}`, `pr/${O1}/1`])}`),
      // Review routines (docs/reviews.md): a report, a start and a report of another routine, an admin delete.
      async () => o1.post("/api/reviews/report", { stamp: stamp(tick++), result: "ok", report: reportOf([1, 2 + R.int(3)]) }),
      async () => o2.post(`/api/reviews/runs/${stamp(tick++)}/start`, {}),
      async () => o2.post("/api/reviews/report", { stamp: stamp(tick++), result: R.pick(["ok", "failed"]), report: reportOf([7]) }),
      async () => human.del(`/api/reviews/${R.pick([O1, O2])}`),
      // Fleets: fleet fa's token posts an item in its fleet, an admin moves one between fleets, fa's routine reports.
      async () => {
        const id = uid("f");
        ids.push(id);
        return fa.put(`/api/items/${id}`, { data: { type: "decision", title: id } });
      },
      async () => human.patch(`/api/items/${R.pick(ids)}`, { data: { fleet: moveFleet() } }),
      async () => o3.post("/api/reviews/report", { stamp: stamp(tick++), result: "ok", report: reportOf([3]) }),
    ];

    // Each kind ROUNDS times (creates twice that, as deletes use them up), in a seeded shuffle; the first step
    // creates an item so the others have one to pick.
    const ROUNDS = 3;
    const deck = Array.from({ length: ROUNDS }, () => [0, ...ops.map((_, k) => k)]).flat();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = R.int(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    deck.splice(deck.indexOf(0), 1);
    deck.unshift(0);

    // Some ops are refused in some states (deciding an archived item, a snooze on a decided one); every kind
    // must land at least once, or the run proves nothing about it. Callers pull in turn, every PULL_EVERY steps.
    const PULL_EVERY = 2;
    const landed = new Set<number>();
    for (const [step, turn] of deck.entries()) {
      const k = ids.length ? turn : 0;
      const r = await ops[k]();
      expect(r.status, `step ${step}`).toBeLessThan(500);
      if (r.status < 300) landed.add(k);
      if (step % PULL_EVERY === PULL_EVERY - 1) await pull(viewers[((step + 1) / PULL_EVERY - 1) % viewers.length], step);
    }
    for (const v of viewers) await pull(v, deck.length);
    expect(ops.map((_, k) => k).filter((k) => !landed.has(k)), "kinds that never landed").toEqual([]);
    const merges = viewers.flatMap((v) => [`${v.name} updated`, `${v.name} removed`, `${v.name} routines`])
      .concat(["admin pins", "A pins", "B pins"]); // tokens never get pins
    expect(merges.filter((m) => !covered.has(m)), "merges no caller made").toEqual([]);
  });
});
