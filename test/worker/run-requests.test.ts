// The Run button's requests (docs/reviews.md "Run requests"): only a decider or admin human asks, at most one waits
// at a time, a live run holds the button, and only the routine's own token moves a request along.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { RUN_REQUEST_STALE_MS, RUN_STALE_MS } from "../../shared/reviews.ts";
import { agent, call, human, mintToken, person, setRoles } from "./helpers.ts";
import { changesFor, reportOf, routine, stamp } from "./reviews-helpers.ts";

const viewer = person("viewer@rq.test"), decider = person("decider@rq.test");
let manager: ReturnType<typeof agent>;

// The runner's stamp for an instant, so a run started "now" counts as live.
const stampAt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/:/g, "") + "Z";
const ask = (who: { post: typeof human.post }, id: string) => who.post(`/api/reviews/${id}/run-request`, {});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// A routine that has reported once, so it has a head row and shows in the tab.
async function reported() {
  const r = await routine("rq");
  expect((await r.report({ stamp: stamp(0), report: reportOf([4700]) })).status).toBe(201);
  return { ...r, update: (id: string, body: Record<string, unknown>) => r.client.post(`/api/reviews/run-requests/${id}`, body) };
}

beforeAll(async () => {
  await setRoles({ "you@test": "admin", "viewer@rq.test": "viewer", "decider@rq.test": "decider" });
  manager = agent((await mintToken("manager")).secret);
});

describe("who may ask for a run", () => {
  it("a decider or admin human asks; a viewer and every token are refused", async () => {
    const r = await reported();
    expect((await ask(viewer, r.id)).status).toBe(403);
    expect((await manager.post(`/api/reviews/${r.id}/run-request`, {})).status).toBe(403);
    expect((await r.client.post(`/api/reviews/${r.id}/run-request`, {})).status).toBe(403);
    expect((await call("POST", `/api/reviews/${r.id}/run-request`, { token: r.token, host: "inbox.test", body: {} })).status).toBe(403);
    const res = await ask(decider, r.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.request).toMatchObject({ status: "requested", requested_by: "decider@rq.test", stamp: null, message: null });
    expect(res.body.request.id).toMatch(/^rq-\d{8}T\d{6}-[0-9a-f]{8}$/);

    const other = await reported();
    expect((await ask(human, other.id)).status).toBe(201);
  });

  it("a routine that has never reported is 404", async () => {
    expect((await ask(decider, "no-such-routine")).status).toBe(404);
  });
});

describe("one run per click", () => {
  it("a second ask while one waits is 409 with the waiting request, and the head is untouched", async () => {
    const r = await reported();
    const first = (await ask(decider, r.id)).body.request;
    const version = (await human.get(`/api/reviews/${r.id}`)).body.routine.version;
    const again = await ask(human, r.id);
    expect(again.status).toBe(409);
    expect(again.body.current.request).toEqual(first);
    expect((await human.get(`/api/reviews/${r.id}`)).body.routine.version).toBe(version);
    // Picked up and starting still holds it.
    expect((await r.update(first.id, { status: "starting", message: "waiting for 4 GB" })).status).toBe(200);
    expect((await ask(decider, r.id)).status).toBe(409);
  });

  it("a request the poller left for RUN_REQUEST_STALE_MS no longer holds it: a new one replaces it", async () => {
    const r = await reported();
    const old = (await ask(decider, r.id)).body.request;
    await env.DB.prepare("UPDATE review_routines SET run_request = json_set(run_request, '$.updated_at', ?2) WHERE routine = ?1")
      .bind(r.id, ago(RUN_REQUEST_STALE_MS + 60_000))
      .run();
    const res = await ask(decider, r.id);
    expect(res.status).toBe(201);
    expect(res.body.request.id).not.toBe(old.id);
    // The old one is gone: the poller's late update of it is 404.
    expect((await r.update(old.id, { status: "starting" })).status).toBe(404);
  });

  it("a run going holds it (a scheduled or hand-started one too), until it finishes or goes stale", async () => {
    const r = await reported();
    const s = stampAt(Date.now() - 60_000);
    expect((await r.start(s)).status).toBe(201);
    const res = await ask(decider, r.id);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain(s);
    expect((await r.report({ stamp: s, report: reportOf([4700]) })).status).toBe(201);
    expect((await ask(decider, r.id)).status).toBe(201);

    // A runner that died mid-run leaves `running` behind; after RUN_STALE_MS it no longer holds the button.
    const dead = await reported();
    expect((await dead.start(stampAt(Date.now() - RUN_STALE_MS - 60_000))).status).toBe(201);
    expect((await ask(decider, dead.id)).status).toBe(201);
  });

  it("a finished request (started, skipped or failed) doesn't hold it", async () => {
    for (const status of ["skipped", "failed"] as const) {
      const r = await reported();
      const id = (await ask(decider, r.id)).body.request.id;
      expect((await r.update(id, { status, message: "a run was still going" })).status).toBe(200);
      expect((await ask(decider, r.id)).status).toBe(201);
    }
  });
});

describe("the poller's updates", () => {
  it("requested → starting → started, each a head bump with one change row; a retry answers as stored", async () => {
    const r = await reported();
    const before = (await changesFor(r.id)).length;
    const id = (await ask(decider, r.id)).body.request.id;
    const starting = await r.update(id, { status: "starting", message: "waiting for 4 GB of free memory" });
    expect(starting.status).toBe(200);
    expect(starting.body.request).toMatchObject({ id, status: "starting", message: "waiting for 4 GB of free memory", stamp: null });
    const s = stampAt(Date.now());
    const started = await r.update(id, { status: "started", stamp: s });
    expect(started.body.request).toMatchObject({ id, status: "started", stamp: s, message: null, requested_by: "decider@rq.test" });
    expect(Date.parse(started.body.request.updated_at)).toBeGreaterThanOrEqual(Date.parse(started.body.request.requested_at));

    const log = (await changesFor(r.id)).slice(before);
    expect(log.map((c) => c.actor)).toEqual(["human:decider@rq.test", `token:${r.name}`, `token:${r.name}`]);
    expect(log.every((c) => c.orchestrator === r.id && c.op === "update")).toBe(true);

    // The retry is a no-op; the same status with another stamp, or a move back, is 409.
    const version = (await human.get(`/api/reviews/${r.id}`)).body.routine.version;
    expect((await r.update(id, { status: "started", stamp: s })).body.request).toEqual(started.body.request);
    expect((await r.update(id, { status: "started", stamp: stamp(5) })).status).toBe(409);
    const back = await r.update(id, { status: "skipped" });
    expect(back.status).toBe(409);
    expect(back.body.current.request.status).toBe("started");
    expect((await r.update(id, { status: "starting" })).status).toBe(409);
    expect((await human.get(`/api/reviews/${r.id}`)).body.routine.version).toBe(version);
    expect((await human.get(`/api/reviews/${r.id}`)).body.routine.run_request).toEqual(started.body.request);
    // A run that exits before Claude starts fails its started request; that's final.
    const failed = await r.update(id, { status: "failed", message: "the run exited before Claude started" });
    expect(failed.body.request).toMatchObject({ status: "failed", stamp: null, message: "the run exited before Claude started" });
    expect((await r.update(id, { status: "started", stamp: s })).status).toBe(409);
  });

  it("only the routine's own token updates: others are 403, another routine's token finds nothing", async () => {
    const r = await reported(), other = await reported();
    const id = (await ask(decider, r.id)).body.request.id;
    expect((await human.post(`/api/reviews/run-requests/${id}`, { status: "starting" })).status).toBe(403);
    expect((await manager.post(`/api/reviews/run-requests/${id}`, { status: "starting" })).status).toBe(403);
    expect((await other.update(id, { status: "starting" })).status).toBe(404);
    expect((await human.get(`/api/reviews/${r.id}/run-request`)).body.request.status).toBe("requested");
  });

  it("refuses a bad body", async () => {
    const r = await reported();
    const id = (await ask(decider, r.id)).body.request.id;
    for (const body of [{}, { status: "requested" }, { status: "done" }, { status: "started" }, { status: "started", stamp: "now" }, { status: "skipped", stamp: stamp(0) }, { status: "failed", message: "x".repeat(501) }]) {
      expect((await r.update(id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("reading the request", () => {
  it("GET /reviews/:routine/run-request: the routine's token for its own, humans and the manager for any", async () => {
    const r = await reported(), other = await reported();
    expect((await r.client.get(`/api/reviews/${r.id}/run-request`)).body).toEqual({ request: null });
    const req = (await ask(decider, r.id)).body.request;
    expect((await r.client.get(`/api/reviews/${r.id}/run-request`)).body).toEqual({ request: req });
    expect((await viewer.get(`/api/reviews/${r.id}/run-request`)).body).toEqual({ request: req });
    expect((await manager.get(`/api/reviews/${r.id}/run-request`)).status).toBe(200);
    expect((await other.client.get(`/api/reviews/${r.id}/run-request`)).status).toBe(403);
    expect((await human.get("/api/reviews/no-such-routine/run-request")).status).toBe(404);
    // The tab reads it from the head.
    expect((await viewer.get(`/api/reviews/${r.id}`)).body.routine.run_request).toEqual(req);
  });
});

describe("next_run_at", () => {
  it("left out keeps the head's; null clears it (a routine that runs on demand only)", async () => {
    const r = await reported();
    const next = "2026-10-21T14:00:00.000Z";
    expect((await r.start(stamp(10), { next_run_at: next })).status).toBe(201);
    expect((await r.report({ stamp: stamp(10), report: reportOf([4700]) })).status).toBe(201);
    expect((await human.get(`/api/reviews/${r.id}`)).body.routine.next_run_at).toBe(next);
    expect((await r.start(stamp(20), { next_run_at: null })).status).toBe(201);
    expect((await human.get(`/api/reviews/${r.id}`)).body.routine.next_run_at).toBe(null);
    expect((await r.report({ stamp: stamp(20), report: reportOf([4700]), next_run_at: next })).status).toBe(201);
    expect((await r.report({ stamp: stamp(30), report: reportOf([4700]), next_run_at: null })).status).toBe(201);
    expect((await human.get(`/api/reviews/${r.id}`)).body.routine.next_run_at).toBe(null);
  });
});
