// /api/reviews: who may read and write what (docs/reviews.md "Who can do what"), the read endpoints, and the
// routines' place in /api/state and /api/changes.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { agent, call, human, mintToken, person, setRoles } from "./helpers.ts";
import { samplePostAsk } from "../fixtures/reviews.ts";
import { reportOf, routine, stamp } from "./reviews-helpers.ts";

const viewer = person("viewer@team.test"), decider = person("decider@team.test");
let mine: Awaited<ReturnType<typeof routine>>, theirs: Awaited<ReturnType<typeof routine>>;
let manager: ReturnType<typeof agent>;

beforeAll(async () => {
  await setRoles({ "you@test": "admin", "viewer@team.test": "viewer", "decider@team.test": "decider" });
  manager = agent((await mintToken("manager")).secret);
  mine = await routine("mine");
  theirs = await routine("theirs");
  expect((await mine.report({ stamp: stamp(0), report: reportOf([4700, 4701]) })).status).toBe(201);
  expect((await theirs.report({ stamp: stamp(0), report: reportOf([5000]) })).status).toBe(201);
});

// Each routine's own PR: mine tracks 4700, theirs 5000.
const readPaths = (id: string) => {
  const n = id === theirs.id ? 5000 : 4700;
  return [`/api/reviews/${id}`, `/api/reviews/${id}/prs/${n}`, `/api/reviews/${id}/runs/${stamp(0)}`];
};
const ids = (body: { routines: { routine: string }[] }) => body.routines.map((r) => r.routine);

describe("scope", () => {
  it("a routine's token reads and writes its own routine, under /agent/api and /api", async () => {
    for (const path of readPaths(mine.id)) {
      expect((await mine.client.get(path)).status, path).toBe(200);
      expect((await call("GET", path, { token: mine.token, host: "inbox.test" })).status, path).toBe(200);
    }
    expect((await mine.start(stamp(30))).status).toBe(201);
    expect((await mine.report({ stamp: stamp(30), report: reportOf([4700]) })).status).toBe(201);
    expect((await call("POST", "/api/reviews/report", { token: mine.token, host: "inbox.test", body: { stamp: stamp(60), result: "failed", report: null } })).status).toBe(201);
  });

  it("a routine's token can't read another routine, and lists only its own", async () => {
    for (const path of readPaths(theirs.id)) expect((await mine.client.get(path)).status, path).toBe(403);
    expect((await mine.client.get("/api/reviews/no-such-routine")).status).toBe(403); // no existence leak
    expect(ids((await mine.client.get("/api/reviews")).body)).toEqual([mine.id]);
    expect((await mine.client.get("/api/state")).body.routines.map((r: { id: string }) => r.id)).toEqual([mine.id]);
  });

  it("a routine's token can't delete, not even its own routine", async () => {
    expect((await mine.client.del(`/api/reviews/${mine.id}`)).status).toBe(403);
  });

  it("an orchestrator token with no reviews writes its own routine only (the first write creates it)", async () => {
    const o = await routine("fresh");
    expect((await o.client.get(`/api/reviews/${o.id}`)).status).toBe(404);
    expect((await o.report({ stamp: stamp(0), report: reportOf([1]) })).status).toBe(201);
    expect((await o.client.get(`/api/reviews/${o.id}`)).body.routine.routine).toBe(o.id);
  });

  it("the manager reads every routine and writes none", async () => {
    for (const id of [mine.id, theirs.id]) for (const path of readPaths(id)) expect((await manager.get(path)).status, path).toBe(200);
    expect(ids((await manager.get("/api/reviews")).body)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect((await manager.post(`/api/reviews/runs/${stamp(90)}/start`, {})).status).toBe(403);
    expect((await manager.post("/api/reviews/report", { stamp: stamp(90), result: "failed", report: null })).status).toBe(403);
    expect((await manager.del(`/api/reviews/${theirs.id}`)).status).toBe(403);
  });

  it("every human role reads every routine; none writes runs", async () => {
    for (const who of [human, viewer, decider]) {
      for (const id of [mine.id, theirs.id]) for (const path of readPaths(id)) expect((await who.get(path)).status, path).toBe(200);
      expect(ids((await who.get("/api/reviews")).body)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect((await who.post(`/api/reviews/runs/${stamp(90)}/start`, {})).status).toBe(403);
      expect((await who.post("/api/reviews/report", { stamp: stamp(90), result: "failed", report: null })).status).toBe(403);
    }
  });

  it("only an admin deletes a routine: everything it wrote goes, and it leaves the lists", async () => {
    const dry = await routine("dry");
    await dry.start(stamp(0));
    await dry.report({ stamp: stamp(0), report: reportOf([1, 4]) });
    expect((await viewer.del(`/api/reviews/${dry.id}`)).status).toBe(403);
    expect((await decider.del(`/api/reviews/${dry.id}`)).status).toBe(403);
    const res = await human.del(`/api/reviews/${dry.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, runs: 1, prs: 2, events: 1 });
    for (const t of ["review_routines", "review_runs", "review_prs", "review_events"]) {
      expect((await env.DB.prepare(`SELECT count(*) AS n FROM ${t} WHERE routine = ?`).bind(dry.id).first<{ n: number }>())!.n, t).toBe(0);
    }
    expect((await human.get(`/api/reviews/${dry.id}`)).status).toBe(404);
    expect(ids((await human.get("/api/reviews")).body)).not.toContain(dry.id);
    expect((await human.get("/api/state")).body.routines.map((r: { id: string }) => r.id)).not.toContain(dry.id);
    expect((await human.del(`/api/reviews/${dry.id}`)).status).toBe(404);
    // The routine's token can start over.
    expect((await dry.report({ stamp: stamp(30), report: reportOf([1]) })).status).toBe(201);
  });

  it("needs authentication", async () => {
    expect((await call("GET", "/api/reviews", { host: "inbox.test" })).status).toBe(401);
    expect((await call("GET", "/agent/api/reviews", { host: "inbox.test" })).status).toBe(401);
  });
});

describe("reads", () => {
  it("GET /reviews summarizes each routine: last run, counts, needs you, running, next run", async () => {
    const r = await routine("sum");
    // samplePr: 4700 is held_product (with needs_you), 4701 held_owner, 4703 mine_draft, 4704 bot.
    await r.report({ stamp: stamp(0), report: reportOf([4700, 4701, 4703, 4704]), next_run_at: "2026-10-08T16:00:00Z" });
    let s = (await human.get("/api/reviews")).body.routines.find((x: { routine: string }) => x.routine === r.id);
    expect(s).toEqual({
      routine: r.id,
      version: 1,
      last_run: { stamp: stamp(0), result: "ok", finished_at: expect.any(String), headline: expect.any(String) },
      next_run_at: "2026-10-08T16:00:00.000Z",
      counts: { held_product: 1, held_owner: 1, mine_draft: 1, bot: 1 },
      needs_you: 1,
      running: null,
    });
    await r.start(stamp(30), { started_at: "2026-10-08T14:30:05Z" });
    s = (await human.get("/api/reviews")).body.routines.find((x: { routine: string }) => x.routine === r.id);
    expect(s.running).toEqual({ stamp: stamp(30), started_at: "2026-10-08T14:30:05.000Z" });
    expect(s.last_run.stamp).toBe(stamp(0));
    await r.report({ stamp: stamp(30), report: reportOf([4701]) });
    s = (await human.get("/api/reviews")).body.routines.find((x: { routine: string }) => x.routine === r.id);
    expect(s).toMatchObject({ running: null, last_run: { stamp: stamp(30) }, counts: { held_owner: 1 }, needs_you: 0 });
  });

  it("stores a post ask and an awaiting_ok PR, and counts the status", async () => {
    const r = await routine("post");
    const report = reportOf([4701], { schema: 2, asks: [samplePostAsk(4701)], resolved: [] }, () => ({ status: "awaiting_ok" }));
    expect((await r.report({ stamp: stamp(0), report })).status).toBe(201);
    const s = (await human.get("/api/reviews")).body.routines.find((x: { routine: string }) => x.routine === r.id);
    expect(s.counts).toEqual({ awaiting_ok: 1 });
    const run = (await human.get(`/api/reviews/${r.id}/runs/${stamp(0)}`)).body;
    expect(run.data.asks[0].review).toMatchObject({ hold: "post", event: "REQUEST_CHANGES" });
    const bad = reportOf([4701], { schema: 2, asks: [samplePostAsk(4701, { review: { pr: 4701, hold: "post", event: "MERGE" as never } })], resolved: [] });
    expect((await r.report({ stamp: stamp(30), report: bad })).status).toBe(400);
  });

  it("a run left running by a dead runner stops counting as running once a later run finishes", async () => {
    const r = await routine("dead");
    await r.start(stamp(0));
    await r.report({ stamp: stamp(30), report: reportOf([1]) });
    expect((await human.get("/api/reviews")).body.routines.find((x: { routine: string }) => x.routine === r.id).running).toBeNull();
  });

  it("GET /reviews/:routine: the head, current PRs plus those gone in the last 7 days, newest runs first", async () => {
    const r = await routine("view");
    await r.report({ stamp: stamp(0), report: reportOf([1, 2, 3]) });
    await r.report({ stamp: stamp(30), report: reportOf([2, 3]) }); // 1 gone now
    await r.report({ stamp: stamp(60), report: reportOf([3]) }); // 2 gone now
    await env.DB.prepare("UPDATE review_prs SET gone_at = ? WHERE routine = ? AND number = 1")
      .bind(new Date(Date.now() - 8 * 86_400_000).toISOString(), r.id)
      .run();
    const v = (await human.get(`/api/reviews/${r.id}`)).body;
    expect(v.routine).toMatchObject({ routine: r.id, version: 3, last_stamp: stamp(60) });
    expect(v.prs.map((p: { number: number; gone_at: string | null }) => [p.number, !!p.gone_at])).toEqual([
      [3, false],
      [2, true],
    ]);
    expect(v.prs[0]).toMatchObject({ role: "mine", status: "mine_draft", needs_you: false, gh: null, last_stamp: stamp(60) });
    expect(v.runs.map((x: { stamp: string }) => x.stamp)).toEqual([stamp(60), stamp(30), stamp(0)]);
    expect(v.more).toBe(false);
  });

  it("pages runs with before and limit", async () => {
    const r = await routine("page");
    for (const m of [0, 30, 60, 90, 120]) await r.report({ stamp: stamp(m), result: "failed", report: null });
    const p1 = (await human.get(`/api/reviews/${r.id}?limit=2`)).body;
    expect(p1.runs.map((x: { stamp: string }) => x.stamp)).toEqual([stamp(120), stamp(90)]);
    expect(p1.more).toBe(true);
    const p2 = (await human.get(`/api/reviews/${r.id}?limit=2&before=${stamp(90)}`)).body;
    expect(p2.runs.map((x: { stamp: string }) => x.stamp)).toEqual([stamp(60), stamp(30)]);
    expect(p2.more).toBe(true);
    const p3 = (await human.get(`/api/reviews/${r.id}?limit=2&before=${stamp(30)}`)).body;
    expect(p3.runs.map((x: { stamp: string }) => x.stamp)).toEqual([stamp(0)]);
    expect(p3.more).toBe(false);
    for (const q of ["limit=0", "limit=101", "limit=x", "before=yesterday"]) expect((await human.get(`/api/reviews/${r.id}?${q}`)).status, q).toBe(400);
  });

  it("GET /reviews/:routine/prs/:n: the row and its events, newest first", async () => {
    const r = await routine("pr");
    await r.report({ stamp: stamp(0), report: reportOf([4700]) });
    await r.report({ stamp: stamp(30), report: reportOf([4700]) });
    const v = (await human.get(`/api/reviews/${r.id}/prs/4700`)).body;
    expect(v.pr).toMatchObject({ number: 4700, url: "https://github.com/acme/widgets/pull/4700", last_stamp: stamp(30) });
    expect(v.events.map((e: { stamp: string }) => e.stamp)).toEqual([stamp(30), stamp(0)]);
    expect(v.events[0].data).toMatchObject({ pr: 4700, stamp: stamp(30), action: "approved", status: "held_product", changes: [expect.any(String)] });
    expect((await human.get(`/api/reviews/${r.id}/prs/4999`)).status).toBe(404);
    expect((await human.get(`/api/reviews/${r.id}/prs/0`)).status).toBe(400);
    expect((await human.get(`/api/reviews/${r.id}/prs/12a`)).status).toBe(400);
  });

  it("GET /reviews/:routine/runs/:stamp: one run; 404 and 400 otherwise", async () => {
    expect((await human.get(`/api/reviews/${mine.id}/runs/${stamp(0)}`)).body).toMatchObject({ routine: mine.id, stamp: stamp(0), result: "ok" });
    expect((await human.get(`/api/reviews/${mine.id}/runs/2020-01-01T000000Z`)).status).toBe(404);
    expect((await human.get(`/api/reviews/${mine.id}/runs/today`)).status).toBe(400);
  });

  it("a start's stamp must be a real UTC stamp", async () => {
    for (const s of ["2026-10-08T18%3A00%3A00Z", "2026-02-30T120000Z", "latest"]) {
      expect((await mine.client.post(`/api/reviews/runs/${s}/start`, {})).status, s).toBe(400);
    }
  });
});

describe("/api/state and /api/changes", () => {
  it("/api/state lists every routine with its last finished run", async () => {
    const r = await routine("st");
    await r.start(stamp(0));
    let entry = (await human.get("/api/state")).body.routines.find((x: { id: string }) => x.id === r.id);
    expect(entry).toEqual({ id: r.id, version: 1, last_run_at: null, result: null });
    const rep = await r.report({ stamp: stamp(0), result: "seed", report: reportOf([1]) });
    entry = (await human.get("/api/state")).body.routines.find((x: { id: string }) => x.id === r.id);
    expect(entry).toEqual({ id: r.id, version: 2, last_run_at: rep.body.run.finished_at, result: "seed" });
    const all = (await human.get("/api/state")).body.routines.map((x: { id: string }) => x.id);
    expect(all).toEqual([...all].sort());
  });

  it("/api/changes?collection=reviews has the routines' rows; a routine's token sees only its own", async () => {
    const since = (await human.get("/api/changes")).body.cursor;
    await mine.report({ stamp: stamp(200), result: "failed", report: null });
    await theirs.report({ stamp: stamp(200), result: "failed", report: null });
    await human.put("/api/items/rv-noise", { data: { type: "info", title: "noise" } });
    const all = (await human.get(`/api/changes?since=${since}&collection=reviews`)).body.changes;
    expect(all.map((c: { doc_id: string }) => c.doc_id)).toEqual([mine.id, theirs.id]);
    expect(all.every((c: { collection: string; actor: string }) => c.collection === "reviews" && c.actor.startsWith("token:"))).toBe(true);
    const own = (await mine.client.get(`/api/changes?since=${since}`)).body.changes;
    expect(own.map((c: { collection: string; doc_id: string }) => [c.collection, c.doc_id])).toEqual([["reviews", mine.id]]);
  });
});
