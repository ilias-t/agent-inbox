// POST /api/reviews/report and /runs/:stamp/start through the real Worker and D1: what each write stores, that
// each lands whole or not at all with exactly one change row, replays and conflicts, PR state moving only
// forward, gone marking, and the number of D1 statements a report costs (docs/reviews.md "Write semantics").
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { headBump } from "../../worker/reviews.ts";
import { sampleReport } from "../fixtures/reviews.ts";
import { human } from "./helpers.ts";
import { changesFor, maxSeq, reportOf, routine, rows, stamp } from "./reviews-helpers.ts";

// Runs `write` and returns its result with the change rows it added for the routine.
async function logged<T>(id: string, write: () => Promise<T>) {
  const before = (await changesFor(id)).length;
  const result = await write();
  return { result, added: (await changesFor(id)).slice(before) };
}

describe("POST /api/reviews/report", () => {
  it("stores the run, every PR and the events in one write, logged as one change row from the head", async () => {
    const r = await routine();
    const report = reportOf([4700, 4701, 4704]); // 4700 and 4704 acted this run (samplePr: number % 4 === 0)
    const { result, added } = await logged(r.id, () =>
      r.report({ stamp: stamp(0), report, exit: 0, log: "runner:/logs/x.log", notify: "NOTIFY: none", next_run_at: "2026-10-08T16:00:00Z" }),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body).toMatchObject({ prs_written: 3, events_written: 2, gone: 0 });
    expect(result.body.run).toMatchObject({ routine: r.id, stamp: stamp(0), result: "ok", has_report: true, dry: false });
    expect(result.body.run.data).toMatchObject({ exit: 0, log: "runner:/logs/x.log", notify: "NOTIFY: none", schema: 1, headline: report.headline });
    expect(result.body.run.data.actions.map((a: { pr: number }) => a.pr)).toEqual([4700, 4704]);
    expect(added).toEqual([
      { seq: expect.any(Number), collection: "reviews", doc_id: r.id, op: "create", version: 1, actor: `token:${r.name}`, orchestrator: r.id },
    ]);
    const db = await rows(r.id);
    expect(db.head).toMatchObject({ version: 1, last_stamp: stamp(0), next_run_at: "2026-10-08T16:00:00.000Z" });
    expect(db.prs.map((p) => p.number)).toEqual([4700, 4701, 4704]);
    expect(db.events).toEqual([
      { number: 4700, stamp: stamp(0) },
      { number: 4704, stamp: stamp(0) },
    ]);
  });

  it("keeps each PR entry as the run wrote it, with the url's trailing slashes trimmed for the hook", async () => {
    const r = await routine();
    const report = reportOf([4700], {}, () => ({ url: "https://github.com/acme/widgets/pull/4700/", mystery: { kept: true } }));
    expect((await r.report({ stamp: stamp(0), report })).status).toBe(201);
    const pr = (await r.client.get(`/api/reviews/${r.id}/prs/4700`)).body.pr;
    expect(pr.url).toBe("https://github.com/acme/widgets/pull/4700");
    expect(pr.data).toEqual(report.prs[0]);
  });

  it("a run without a report stores only its record: PR state is left alone", async () => {
    const r = await routine();
    await r.report({ stamp: stamp(0), report: reportOf([4700, 4701]) });
    const { result, added } = await logged(r.id, () => r.report({ stamp: stamp(30), result: "failed", exit: 1, error: "the review exited 1", report: null }));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ prs_written: 0, events_written: 0, gone: 0, run: { result: "failed", has_report: false } });
    expect(added).toHaveLength(1);
    const db = await rows(r.id);
    expect(db.head.last_stamp).toBe(stamp(30)); // the Now bar's last run is the failed one
    expect(db.prs.every((p) => p.gone_at === null && p.last_stamp === stamp(0))).toBe(true);
  });

  it("finishes a started run: start and report each log one change row, and the start's model survives", async () => {
    const r = await routine();
    const s = await logged(r.id, () => r.start(stamp(0), { model: "opus", log: "runner:/logs/a.log", next_run_at: "2026-10-08T16:00:00.000Z" }));
    expect(s.result.status).toBe(201);
    expect(s.result.body).toMatchObject({ result: "running", finished_at: null, report_sha: null, data: { model: "opus", result: "running" } });
    expect(s.added.map((c) => [c.op, c.version])).toEqual([["create", 1]]);
    expect((await rows(r.id)).head.last_stamp).toBeNull(); // nothing finished yet
    const rep = await logged(r.id, () => r.report({ stamp: stamp(0), report: reportOf([4700]) }));
    expect(rep.result.status).toBe(201);
    expect(rep.result.body.run).toMatchObject({ result: "ok", data: { model: "opus" } });
    expect(rep.added.map((c) => [c.op, c.version])).toEqual([["update", 2]]);
    expect((await rows(r.id)).head).toMatchObject({ last_stamp: stamp(0), next_run_at: "2026-10-08T16:00:00.000Z" });
  });

  it("replaying the same body is a no-op answering replayed, whatever its key order", async () => {
    const r = await routine();
    const body = { stamp: stamp(0), result: "ok" as const, report: reportOf([4700, 4701]), exit: 0 };
    const first = await r.report(body);
    expect(first.status).toBe(201);
    const seq = await maxSeq();
    const reordered = { exit: 0, report: { ...body.report, prs: body.report.prs }, result: "ok" as const, stamp: stamp(0) };
    for (const again of [body, reordered]) {
      const r2 = await r.report(again);
      expect(r2.status).toBe(200);
      expect(r2.body).toEqual({ run: first.body.run, prs_written: 0, events_written: 0, gone: 0, replayed: true });
    }
    expect(await maxSeq()).toBe(seq);
  });

  it("a different body for a finished run is 409 with the stored run, and writes nothing", async () => {
    const r = await routine();
    const first = await r.report({ stamp: stamp(0), report: reportOf([4700, 4701]) });
    const before = await rows(r.id);
    const seq = await maxSeq();
    const res = await r.report({ stamp: stamp(0), report: reportOf([4702]) });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "conflict", current: first.body.run });
    expect(await rows(r.id)).toEqual(before);
    expect(await maxSeq()).toBe(seq);
  });

  it("a report the validator refuses writes nothing: no head, no rows, no change row", async () => {
    const r = await routine();
    const seq = await maxSeq();
    const bad = reportOf([4700, 4701]);
    bad.prs[1].status = "merged" as never;
    const res = await r.report({ stamp: stamp(0), report: bad });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('report: #4701: unknown status "merged"');
    expect(await rows(r.id)).toEqual({ head: null, runs: [], prs: [], events: [] });
    expect(await maxSeq()).toBe(seq);
  });

  it("names the first five problems and counts the rest", async () => {
    const r = await routine();
    const bad = reportOf([1, 2, 3, 4, 5, 6, 7], {}, () => ({ risk: "x" as never }));
    const res = await r.report({ stamp: stamp(0), report: bad });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^report: #1: unknown risk "x"; .*; report: #5: unknown risk "x" \(and 2 more\)$/);
  });

  it("stamps the routine from the token: a routine in the body is ignored", async () => {
    const r = await routine();
    const other = await routine();
    const res = await r.client.post("/api/reviews/report", { stamp: stamp(0), result: "ok", report: reportOf([4700]), routine: other.id });
    expect(res.status).toBe(201);
    expect(res.body.run.routine).toBe(r.id);
    expect((await rows(other.id)).runs).toEqual([]);
  });

  it("a started run's late start (after its report) returns the run as stored and writes nothing", async () => {
    const r = await routine();
    const rep = await r.report({ stamp: stamp(0), report: reportOf([4700]) });
    const seq = await maxSeq();
    const late = await r.start(stamp(0), { model: "other" });
    expect(late.status).toBe(200);
    expect(late.body).toEqual(rep.body.run);
    const again = await r.start(stamp(30));
    expect(again.status).toBe(201);
    const retry = await r.start(stamp(30), { model: "different" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(again.body);
    expect(await maxSeq()).toBe(seq + 1); // only the new start at stamp(30) logged
  });
});

describe("PR state moves only forward; the newest report decides what is current", () => {
  it("marks gone the PRs a newer report drops, and brings back one it lists again", async () => {
    const r = await routine();
    await r.report({ stamp: stamp(0), report: reportOf([1, 2, 3]) });
    const second = await r.report({ stamp: stamp(30), report: reportOf([2, 3]) });
    expect(second.body).toMatchObject({ prs_written: 2, gone: 1 });
    let prs = (await rows(r.id)).prs;
    expect(prs.filter((p) => p.gone_at).map((p) => p.number)).toEqual([1]);
    const third = await r.report({ stamp: stamp(60), report: reportOf([1, 2]) });
    expect(third.body).toMatchObject({ prs_written: 2, gone: 1 });
    prs = (await rows(r.id)).prs;
    expect(prs.map((p) => [p.number, p.last_stamp, !!p.gone_at])).toEqual([
      [1, stamp(60), false],
      [2, stamp(60), false],
      [3, stamp(30), true],
    ]);
  });

  it("a late retry of an older run never moves a PR back, nor un-gones one the newest report dropped", async () => {
    const r = await routine();
    await r.report({ stamp: stamp(0), report: reportOf([1, 2]) });
    await r.report({ stamp: stamp(60), report: reportOf([2, 5], {}, () => ({ status: "approved" })) }); // 1 gone
    const late = await logged(r.id, () => r.report({ stamp: stamp(30), report: reportOf([1, 2, 9], {}, () => ({ status: "pending" })) }));
    expect(late.result.status).toBe(201);
    // 1 and 9 aren't in the newest report: 1 takes the newer data but stays gone, 9 goes in already gone.
    // 2 was written by a newer run and stays as it was. Nothing is marked gone by an older report (5 stays).
    expect(late.result.body).toMatchObject({ prs_written: 2, gone: 0 });
    expect(late.added).toHaveLength(1);
    const prs = (await rows(r.id)).prs;
    expect(prs.map((p) => [p.number, p.status, p.last_stamp, !!p.gone_at])).toEqual([
      [1, "pending", stamp(30), true],
      [2, "approved", stamp(60), false],
      [5, "approved", stamp(60), false],
      [9, "pending", stamp(30), true],
    ]);
    expect((await rows(r.id)).head.last_stamp).toBe(stamp(60));
    // The late run is still in the history, with its events.
    expect((await r.client.get(`/api/reviews/${r.id}/runs/${stamp(30)}`)).body.result).toBe("ok");
  });

  it("only the newest run the routine knows moves next_run_at: never a late report or an older start", async () => {
    const next = async (id: string) => (await rows(id)).head.next_run_at;
    const r = await routine();
    await r.report({ stamp: stamp(60), report: reportOf([1]), next_run_at: "2026-10-08T18:00:00.000Z" });
    await r.report({ stamp: stamp(30), report: reportOf([1]), next_run_at: "2026-10-08T16:00:00.000Z" });
    expect(await next(r.id)).toBe("2026-10-08T18:00:00.000Z");
    await r.start(stamp(90), { next_run_at: "2026-10-08T20:00:00.000Z" });
    expect(await next(r.id)).toBe("2026-10-08T20:00:00.000Z");
    // The newer run has only started: its own report still moves it.
    await r.report({ stamp: stamp(90), report: reportOf([1]), next_run_at: "2026-10-08T21:00:00.000Z" });
    expect(await next(r.id)).toBe("2026-10-08T21:00:00.000Z");

    // S0 and S2 report, then a start of an older stamp S1 (a retried or delayed start).
    const a = await routine();
    await a.report({ stamp: stamp(0), report: reportOf([1]), next_run_at: "2026-10-08T16:00:00.000Z" });
    await a.report({ stamp: stamp(120), report: reportOf([1]), next_run_at: "2026-10-08T20:00:00.000Z" });
    expect((await a.start(stamp(60), { next_run_at: "2026-10-08T15:00:00.000Z" })).status).toBe(201);
    expect(await next(a.id)).toBe("2026-10-08T20:00:00.000Z");

    // S0 reports, S2 starts, then S1's late report.
    const b = await routine();
    await b.report({ stamp: stamp(0), report: reportOf([1]), next_run_at: "2026-10-08T16:00:00.000Z" });
    await b.start(stamp(120), { next_run_at: "2026-10-08T20:00:00.000Z" });
    await b.report({ stamp: stamp(60), report: reportOf([1]), next_run_at: "2026-10-08T18:00:00.000Z" });
    expect(await next(b.id)).toBe("2026-10-08T20:00:00.000Z");
  });

  it("a report keeps the start's log and model when it names neither, and its own when it does", async () => {
    const r = await routine();
    await r.start(stamp(0), { model: "opus", log: "runner:/logs/a.log" });
    const kept = await r.report({ stamp: stamp(0), result: "failed", report: null });
    expect(kept.body.run.data).toMatchObject({ model: "opus", log: "runner:/logs/a.log" });
    await r.start(stamp(30), { model: "opus", log: "runner:/logs/b.log" });
    const own = await r.report({ stamp: stamp(30), result: "failed", report: null, model: "sonnet", log: "runner:/logs/c.log" });
    expect(own.body.run.data).toMatchObject({ model: "sonnet", log: "runner:/logs/c.log" });
  });

  it("a report's events inherit the start's log when the report names none, and carry its own when it does", async () => {
    const r = await routine();
    const eventLogs = async () =>
      (await env.DB.prepare("SELECT stamp, json_extract(data, '$.log') AS log FROM review_events WHERE routine = ? ORDER BY stamp, number").bind(r.id).all())
        .results;
    await r.start(stamp(0), { log: "runner:/logs/a.log" });
    expect((await r.report({ stamp: stamp(0), report: reportOf([4700]) })).status).toBe(201);
    await r.start(stamp(30), { log: "runner:/logs/b.log" });
    expect((await r.report({ stamp: stamp(30), report: reportOf([4700]), log: "runner:/logs/c.log" })).status).toBe(201);
    expect((await r.report({ stamp: stamp(60), report: reportOf([4700]) })).status).toBe(201); // no start, no log
    expect(await eventLogs()).toEqual([
      { stamp: stamp(0), log: "runner:/logs/a.log" },
      { stamp: stamp(30), log: "runner:/logs/c.log" },
      { stamp: stamp(60), log: null },
    ]);
    const pr = (await r.client.get(`/api/reviews/${r.id}/prs/4700`)).body;
    expect(pr.events.map((e: { data: { log: string | null } }) => e.data.log)).toEqual([null, "runner:/logs/c.log", "runner:/logs/a.log"]);
  });

  it("an older report never marks gone a PR the newest report lists", async () => {
    const r = await routine();
    await r.report({ stamp: stamp(60), report: reportOf([2, 5]) });
    await r.report({ stamp: stamp(30), report: reportOf([2]) });
    expect((await rows(r.id)).prs.every((p) => p.gone_at === null)).toBe(true);
  });

  it("a failed run without a report doesn't count as the newest report", async () => {
    const r = await routine();
    await r.report({ stamp: stamp(0), report: reportOf([1, 2]) });
    await r.report({ stamp: stamp(60), result: "timed_out", report: null });
    const late = await r.report({ stamp: stamp(30), report: reportOf([2]) });
    expect(late.body).toMatchObject({ gone: 1 }); // stamp(30) is the newest report, so it decides
  });
});

describe("one change row per write, under the real statements' conflict policy", () => {
  // SQLite runs a trigger's statements under the conflict policy of the statement that fired it (migration
  // 0008's lesson). The head is written with INSERT ... ON CONFLICT DO UPDATE, which fires the UPDATE trigger;
  // its INSERT into changes must never conflict. Every path, through the routes, each exactly one row.
  it("report (insert, then update), start, report on a started run and admin delete each log exactly one", async () => {
    const r = await routine();
    const steps: [string, () => Promise<{ status: number }>, string][] = [
      ["first report", () => r.report({ stamp: stamp(0), report: reportOf([1, 2]) }), "create"],
      ["second report", () => r.report({ stamp: stamp(30), report: reportOf([2, 3]) }), "update"],
      ["start", () => r.start(stamp(60)), "update"],
      ["report on the started run", () => r.report({ stamp: stamp(60), report: reportOf([3]) }), "update"],
      ["failed run", () => r.report({ stamp: stamp(90), result: "failed", report: null }), "update"],
      ["admin delete", () => human.del(`/api/reviews/${r.id}`), "delete"],
    ];
    for (const [name, write, op] of steps) {
      const { result, added } = await logged(r.id, write);
      expect(result.status, name).toBeLessThan(300);
      expect(added.map((c) => c.op), name).toEqual([op]);
      expect(added[0].orchestrator, name).toBe(r.id);
    }
    const all = await changesFor(r.id);
    expect(all.map((c) => c.version)).toEqual([1, 2, 3, 4, 5, null]);
    expect(all.at(-1)!.actor).toBe(""); // deletes can't be attributed, as for every table
  });

  it("the head upsert itself: re-running it on an existing head updates and logs once each time", async () => {
    const id = "rv-direct-head";
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) await headBump(env.DB, { routine: id, actor: "test", now }).run();
    const head = await env.DB.prepare("SELECT version FROM review_routines WHERE routine = ?").bind(id).first<{ version: number }>();
    expect(head!.version).toBe(3);
    expect((await changesFor(id)).map((c) => c.op)).toEqual(["create", "update", "update"]);
  });
});

describe("D1 statements per report", () => {
  // D1 counts every statement, those inside a db.batch included, against a request's query limit. A Proxy over
  // the binding records each statement that runs (first/all/run/raw, and every statement of a batch).
  function countingDb(db: D1Database) {
    const ran: string[] = [];
    const real = new WeakMap<object, D1PreparedStatement>();
    const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const p = new Proxy(stmt, {
        get(t, k) {
          if (k === "bind") return (...args: unknown[]) => wrap(t.bind(...args), sql);
          if (k === "first" || k === "all" || k === "run" || k === "raw") {
            return (...args: unknown[]) => {
              ran.push(sql);
              return (t as any)[k](...args);
            };
          }
          const v = (t as any)[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      real.set(p, stmt);
      return p;
    };
    const batchSql = new WeakMap<object, string>();
    const proxy = new Proxy(db, {
      get(t, k) {
        if (k === "prepare") {
          return (sql: string) => {
            const s = wrap(t.prepare(sql), sql);
            batchSql.set(s, sql);
            return s;
          };
        }
        if (k === "batch") {
          return (stmts: D1PreparedStatement[]) => {
            for (const s of stmts) ran.push(`batch: ${batchSql.get(s) ?? "?"}`);
            return t.batch(stmts.map((s) => real.get(s) ?? s));
          };
        }
        const v = (t as any)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { db: proxy as D1Database, ran };
  }

  async function countReport(r: Awaited<ReturnType<typeof routine>>, body: unknown) {
    // last_used_at in the future: the once-a-minute bump (a waitUntil query) stays out of the count.
    await env.DB.prepare("UPDATE tokens SET last_used_at = '2999-01-01T00:00:00.000Z' WHERE name = ?").bind(r.name).run();
    const { db, ran } = countingDb(env.DB);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://inbox.test/agent/api/reviews/report", {
        method: "POST",
        headers: { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...env, DB: db },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status, await res.clone().text()).toBe(201);
    return ran;
  }

  it("is the same for 3 PRs and 45: the token lookup and one batch of six (the fleet guard and five writes)", async () => {
    const r = await routine();
    const small = await countReport(r, { stamp: stamp(0), result: "ok", report: sampleReport(3) });
    const big = await countReport(r, { stamp: stamp(30), result: "ok", report: sampleReport(45) });
    console.log(`D1 statements for a 45-PR report: ${big.length} (${big.filter((s) => s.startsWith("batch:")).length} in its batch)`);
    expect(big.length).toBe(small.length);
    expect(big.length).toBe(7);
    expect(big.filter((s) => s.startsWith("batch:"))).toHaveLength(6);
  });

  it("a replay adds one read to tell a replay from a conflict, and nothing else", async () => {
    const r = await routine();
    const body = { stamp: stamp(0), result: "ok", report: sampleReport(45) };
    await r.report(body as never);
    await env.DB.prepare("UPDATE tokens SET last_used_at = '2999-01-01T00:00:00.000Z' WHERE name = ?").bind(r.name).run();
    const { db, ran } = countingDb(env.DB);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://inbox.test/agent/api/reviews/report", {
        method: "POST",
        headers: { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...env, DB: db },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(ran).toHaveLength(8);
  });
});

describe("body limit", () => {
  it("takes reports over 256 KiB (up to 1 MiB); every other route keeps 256 KiB", async () => {
    const r = await routine();
    // 120 PRs of about 3 KB: past 256 KiB, well under 1 MiB.
    const body = { stamp: stamp(0), result: "ok", report: sampleReport(120) };
    const size = JSON.stringify(body).length;
    expect(size).toBeGreaterThan(256 * 1024);
    expect(size).toBeLessThan(1024 * 1024);
    expect((await r.report(body as never)).status).toBe(201);
    const big = "x".repeat(300 * 1024);
    expect((await human.put("/api/items/too-big", { data: { type: "info", title: big } })).status).toBe(413);
  });

  it("refuses a body over 1 MiB with 413 and writes nothing", async () => {
    const r = await routine();
    const res = await r.report({ stamp: stamp(0), report: sampleReport(1), padding: "x".repeat(1024 * 1024) } as never);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "too_large", message: "Body over 1024 KiB" });
    expect((await rows(r.id)).head).toBeNull();
  });
});
