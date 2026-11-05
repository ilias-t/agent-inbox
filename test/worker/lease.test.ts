import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDoc } from "../../worker/store.ts";
import { call, createItem, human, mintToken, uid } from "./helpers.ts";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM docs WHERE collection = 'meta' AND id = 'lease'").run();
});

const acquire = (body: Record<string, unknown>) => human.post("/api/lease/acquire", body);

describe("lease", () => {
  it("GET with no lease", async () => {
    const r = await human.get("/api/lease");
    expect(r.body).toMatchObject({ lease: null, expired: false });
    expect(typeof r.body.now).toBe("string");
  });

  it("acquires fresh; re-acquire by the same session keeps acquired_at", async () => {
    const a = await acquire({ session_id: "s1", title: "Manager A", url: "https://claude.ai/code/cse_1" });
    expect(a.status).toBe(200);
    expect(a.body.acquired).toBe(true);
    const lease = a.body.lease;
    expect(lease.version).toBe(1);
    expect(lease.data).toMatchObject({ holder_session_id: "s1", holder_title: "Manager A" });
    expect(Date.parse(lease.data.expires_at) - Date.parse(lease.data.heartbeat_at)).toBe(25 * 60_000);

    await new Promise((r) => setTimeout(r, 5));
    const again = await acquire({ session_id: "s1", ttl_min: 60 });
    expect(again.body.lease.version).toBe(2);
    expect(again.body.lease.data.acquired_at).toBe(lease.data.acquired_at);
    expect(again.body.lease.data.holder_title).toBe("Manager A");
    expect(Date.parse(again.body.lease.data.expires_at) - Date.parse(again.body.lease.data.heartbeat_at)).toBe(
      60 * 60_000,
    );
    expect((await acquire({ session_id: "s1", ttl_min: 0 })).status).toBe(400);
    expect((await acquire({})).status).toBe(400);
  });

  it("default TTL follows the pickup interval; max is 300", async () => {
    const ttl = (l: any) => (Date.parse(l.data.expires_at) - Date.parse(l.data.heartbeat_at)) / 60_000;
    try {
      // Pickup 10 (defaults) → max(25, 25) = 25.
      expect(ttl((await acquire({ session_id: "s1" })).body.lease)).toBe(25);
      await human.put("/api/schedule", {
        schedule: { work_hours: "10:00-18:00 Mon-Fri", timezone: "UTC", pickup_interval_min: 120, sweep_interval_min: 120 },
      });
      expect(ttl((await acquire({ session_id: "s1" })).body.lease)).toBe(135);
      expect(ttl((await human.post("/api/lease/renew", { session_id: "s1" })).body.lease)).toBe(135);
      expect(ttl((await acquire({ session_id: "s1", ttl_min: 300 })).body.lease)).toBe(300);
      expect((await acquire({ session_id: "s1", ttl_min: 301 })).status).toBe(400);
    } finally {
      await env.DB.prepare("DELETE FROM docs WHERE collection = 'meta' AND id = 'schedule'").run();
    }
  });

  it("held by another → lease_held; steal needs force + matching if_version", async () => {
    await acquire({ session_id: "s1" });
    const held = await acquire({ session_id: "s2" });
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ error: "lease_held", current: { version: 1, data: { holder_session_id: "s1" } } });
    expect((await acquire({ session_id: "s2", force: true })).body.error).toBe("lease_held");
    expect((await acquire({ session_id: "s2", force: true, if_version: 2 })).body.error).toBe("lease_held");
    expect((await acquire({ session_id: "s2", if_version: 1 })).body.error).toBe("lease_held");
    const stolen = await acquire({ session_id: "s2", force: true, if_version: 1 });
    expect(stolen.status).toBe(200);
    expect(stolen.body.lease.data.holder_session_id).toBe("s2");
    expect(stolen.body.lease.data.acquired_at).toBe(stolen.body.lease.data.heartbeat_at);
  });

  it("an expired lease is acquirable without force", async () => {
    await acquire({ session_id: "s1" });
    await env.DB.prepare(
      "UPDATE docs SET data = json_set(data, '$.expires_at', '2020-01-01T00:00:00.000Z') WHERE collection = 'meta' AND id = 'lease'",
    ).run();
    expect((await human.get("/api/lease")).body.expired).toBe(true);
    const r = await acquire({ session_id: "s2" });
    expect(r.status).toBe(200);
    expect(r.body.lease.data.holder_session_id).toBe("s2");
  });

  it("concurrent acquirers: exactly one wins", async () => {
    const rs = await Promise.all(["a", "b", "c", "d"].map((s) => acquire({ session_id: s })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409 && r.body.error === "lease_held")).toHaveLength(3);
  });

  it("renew: holder only, pinned", async () => {
    const a = await acquire({ session_id: "s1" });
    const other = await human.post("/api/lease/renew", { session_id: "s2" });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("lease_held");
    expect((await human.post("/api/lease/renew", { session_id: "s1", if_version: 9 })).body.error).toBe("conflict");
    const r = await human.post("/api/lease/renew", { session_id: "s1", if_version: 1, ttl_min: 5 });
    expect(r.status).toBe(200);
    expect(r.body.lease.version).toBe(2);
    expect(r.body.lease.data.acquired_at).toBe(a.body.lease.data.acquired_at);
    expect(Date.parse(r.body.lease.data.expires_at) - Date.parse(r.body.lease.data.heartbeat_at)).toBe(5 * 60_000);
  });

  it("release: holder only", async () => {
    await acquire({ session_id: "s1" });
    expect((await human.post("/api/lease/release", { session_id: "s2" })).status).toBe(409);
    expect((await human.post("/api/lease/release", { session_id: "s1" })).body).toEqual({ ok: true });
    expect((await human.get("/api/lease")).body.lease).toBeNull();
    const gone = await human.post("/api/lease/release", { session_id: "s1" });
    expect(gone.status).toBe(409);
    expect(gone.body).toMatchObject({ error: "lease_held", current: null });
  });

  it("meta/lease is not writable through /api/meta", async () => {
    expect((await human.put("/api/meta/lease", { data: { holder_session_id: "x" } })).status).toBe(400);
    expect((await human.patch("/api/meta/lease", { data: {} })).status).toBe(400);
  });
});

// docs/api.md "Lease-checked writes": X-Lease-Session on a manager-token write.
describe("lease-checked writes (X-Lease-Session)", () => {
  let token = "";
  let orchToken = "";
  beforeAll(async () => {
    token = (await mintToken("manager", undefined, uid("mgr-lease"))).secret;
    orchToken = (await mintToken("orchestrator", "OL", uid("orch-OL"))).secret;
  });

  // A manager-token call on /agent, with or without the header.
  const mgr = (method: string, path: string, body?: unknown, session?: string, bearer = token) =>
    call(method, `/agent${path}`, {
      body,
      token: bearer,
      host: "inbox.test",
      headers: session === undefined ? {} : { "X-Lease-Session": session },
    });
  const expire = () =>
    env.DB.prepare(
      "UPDATE docs SET data = json_set(data, '$.expires_at', '2020-01-01T00:00:00.000Z') WHERE collection = 'meta' AND id = 'lease'",
    ).run();
  const item = (id: string) => getDoc<any>(env.DB, "items", id);

  it("the holder's writes pass: items, claim, archive, withdraw, qa, delete, orchestrators, meta, tick request, schedule", async () => {
    await acquire({ session_id: "s1" });
    const a = uid("le"), b = uid("le"), w = uid("le"), o = uid("OL");
    expect((await mgr("PUT", `/api/items/${a}`, { data: { type: "decision", title: "A" } }, "s1")).status).toBe(201);
    expect((await mgr("PATCH", `/api/items/${a}`, { data: { summary: "x" } }, "s1")).status).toBe(200);
    expect((await mgr("POST", `/api/items/${a}/decide`, { choice: "ack" }, "s1")).status).toBe(200);
    expect((await mgr("POST", `/api/items/${a}/claim`, {}, "s1")).status).toBe(200);
    expect((await mgr("POST", `/api/items/${a}/qa`, { text: "done" }, "s1")).status).toBe(201);
    expect((await mgr("POST", `/api/items/${a}/archive`, {}, "s1")).status).toBe(200);
    await createItem(w);
    expect((await mgr("POST", `/api/items/${w}/withdraw`, { if_version: 1 }, "s1")).status).toBe(200);
    await createItem(b);
    expect((await mgr("DELETE", `/api/items/${b}?if_version=1`, undefined, "s1")).status).toBe(200);
    expect((await mgr("PUT", `/api/orchestrators/${o}`, { data: { goal: "g" } }, "s1")).status).toBe(201);
    expect((await mgr("PATCH", `/api/orchestrators/${o}`, { data: { status: "running" } }, "s1")).status).toBe(200);
    expect((await mgr("DELETE", `/api/orchestrators/${o}`, undefined, "s1")).status).toBe(200);
    expect([200, 201]).toContain((await mgr("PUT", "/api/meta/manager", { data: { digest: "d" } }, "s1")).status);
    expect((await mgr("PATCH", "/api/meta/manager", { data: { last_pickup: "now" } }, "s1")).status).toBe(200);
    expect((await mgr("POST", "/api/meta/manager/tick-request", {}, "s1")).status).toBe(200);
    const sched = (await mgr("GET", "/api/schedule")).body;
    expect((await mgr("PUT", "/api/schedule", { schedule: sched.schedule }, "s1")).status).toBe(200);
    await env.DB.prepare("DELETE FROM docs WHERE collection = 'meta' AND id = 'schedule'").run();
  });

  it("a non-holder's write is 409 lease_held with the lease as current, and nothing is written", async () => {
    await acquire({ session_id: "s1" });
    const a = uid("le");
    const before = await createItem(a);
    const r = await mgr("PATCH", `/api/items/${a}`, { data: { summary: "stale" } }, "s2");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lease_held", current: { id: "lease", version: 1, data: { holder_session_id: "s1" } } });
    expect(r.body.index).toBeUndefined();
    expect((await item(a))!.version).toBe(before.version);

    for (const [method, path, body] of [
      ["PUT", `/api/items/${uid("le")}`, { data: { type: "info", title: "x" } }],
      ["POST", `/api/items/${a}/claim`, {}],
      ["POST", `/api/items/${a}/archive`, {}],
      ["POST", `/api/items/${a}/withdraw`, {}],
      ["POST", `/api/items/${a}/qa`, { text: "answer" }],
      ["DELETE", `/api/items/${a}`, undefined],
      ["PUT", `/api/orchestrators/${uid("OL")}`, { data: {} }],
      ["PATCH", "/api/meta/manager", { data: { digest: "x" } }],
      ["POST", "/api/meta/manager/tick-request", {}],
      // Checked before the route's own rules: a missing item is 409 too, not 404.
      ["PATCH", `/api/items/${uid("missing")}`, { data: {} }],
    ] as const) {
      const res = await mgr(method, path, body, "s2");
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body.error).toBe("lease_held");
    }
    expect((await item(a))!.version).toBe(before.version);
  });

  it("no lease at all is lease_held with current: null", async () => {
    const a = uid("le");
    await createItem(a);
    const r = await mgr("PATCH", `/api/items/${a}`, { data: { summary: "x" } }, "s1");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lease_held", current: null });
  });

  it("an expired lease fails even for its holder, until renewed", async () => {
    await acquire({ session_id: "s1" });
    await expire();
    const a = uid("le");
    await createItem(a);
    const r = await mgr("PATCH", `/api/items/${a}`, { data: { summary: "x" } }, "s1");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lease_held", current: { data: { holder_session_id: "s1", expires_at: "2020-01-01T00:00:00.000Z" } } });
    expect(r.body.message).toMatch(/expired/);
    // Renew is never lease-checked, and works on an expired lease you still hold.
    expect((await mgr("POST", "/api/lease/renew", { session_id: "s1" }, "s1")).status).toBe(200);
    expect((await mgr("PATCH", `/api/items/${a}`, { data: { summary: "x" } }, "s1")).status).toBe(200);
  });

  it("after a takeover the old session is refused and the new one passes", async () => {
    await acquire({ session_id: "s1" });
    const stolen = await acquire({ session_id: "s2", force: true, if_version: 1 });
    expect(stolen.status).toBe(200);
    const a = uid("le");
    await createItem(a);
    await human.post(`/api/items/${a}/decide`, { choice: "ack" });
    const old = await mgr("POST", `/api/items/${a}/claim`, { if_version: 2 }, "s1");
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ error: "lease_held", current: { version: 2, data: { holder_session_id: "s2" } } });
    expect((await item(a))!.data.status).toBe("decided");
    expect((await mgr("POST", `/api/items/${a}/claim`, { if_version: 2 }, "s2")).status).toBe(200);
  });

  it("without the header nothing changes: a non-holder manager still writes", async () => {
    await acquire({ session_id: "s1" });
    const a = uid("le");
    await createItem(a);
    expect((await mgr("PATCH", `/api/items/${a}`, { data: { summary: "x" } })).status).toBe(200);
    expect((await mgr("POST", "/api/batch", { ops: [{ op: "item.patch", id: a, data: { summary: "y" } }] })).status).toBe(200);
  });

  it("a batch is checked once, all or nothing", async () => {
    await acquire({ session_id: "s1" });
    await human.put("/api/meta/manager", { data: {} }); // meta.patch needs it
    const a = uid("le"), b = uid("le");
    await createItem(a);
    await createItem(b);
    const ops = [
      { op: "item.patch", id: a, data: { summary: "1" }, if_version: 1 },
      { op: "item.patch", id: b, data: { summary: "2" }, if_version: 1 },
      { op: "meta.patch", id: "manager", data: { last_pickup: "now" } },
    ];
    const seqBefore = (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;
    const r = await mgr("POST", "/api/batch", { ops }, "s2");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lease_held", current: { data: { holder_session_id: "s1" } } });
    expect(r.body.index).toBeUndefined();
    expect((await item(a))!.version).toBe(1);
    expect((await item(b))!.version).toBe(1);
    const seqAfter = (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;
    expect(seqAfter).toBe(seqBefore);

    const ok = await mgr("POST", "/api/batch", { ops }, "s1");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.results).toHaveLength(3);
    expect((await item(a))!.version).toBe(2);
    expect((await item(b))!.version).toBe(2);
  });

  it("reads and the lease endpoints ignore it", async () => {
    await acquire({ session_id: "s1" });
    expect((await mgr("GET", "/api/items", undefined, "s2")).status).toBe(200);
    expect((await mgr("GET", "/api/lease", undefined, "s2")).status).toBe(200);
    // renew/release/acquire answer by their own session_id, whatever the header says.
    expect((await mgr("POST", "/api/lease/renew", { session_id: "s1" }, "s2")).status).toBe(200);
    const other = await mgr("POST", "/api/lease/renew", { session_id: "s2" }, "s2");
    expect(other.body.error).toBe("lease_held");
    const v = (await human.get("/api/lease")).body.lease.version;
    expect((await mgr("POST", "/api/lease/acquire", { session_id: "s2", force: true, if_version: v }, "s1")).status).toBe(200);
  });

  it("humans and orchestrator tokens are unaffected", async () => {
    await acquire({ session_id: "s1" });
    const a = uid("le");
    await createItem(a);
    const h = await call("PATCH", `/api/items/${a}`, { body: { data: { summary: "h" } }, headers: { "X-Lease-Session": "s2" } });
    expect(h.status).toBe(200);
    const o = uid("le");
    const put = await mgr("PUT", `/api/items/${o}`, { data: { type: "info", title: "o", orchestrator: "OL" } }, "s2", orchToken);
    expect(put.status, JSON.stringify(put.body)).toBe(201);
  });

  it("an empty or oversized header is 400", async () => {
    await acquire({ session_id: "s1" });
    const a = uid("le");
    await createItem(a);
    expect((await mgr("PATCH", `/api/items/${a}`, { data: {} }, "")).status).toBe(400);
    expect((await mgr("PATCH", `/api/items/${a}`, { data: {} }, "x".repeat(201))).status).toBe(400);
    expect((await mgr("PATCH", `/api/items/${a}`, { data: {} }, "s1")).status).toBe(200);
  });
});
