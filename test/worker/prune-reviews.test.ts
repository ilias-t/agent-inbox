// pruneReviews in the daily cron: runs and events past REVIEWS_RETENTION_DAYS (default 90), PRs gone over 30
// days, each routine's newest run and last_stamp run kept whatever their age, and no change rows.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { pruneReviews, reviewsRetentionDays, toStamp } from "../../worker/prune.ts";
import { human } from "./helpers.ts";
import { maxSeq, reportOf, routine, rows } from "./reviews-helpers.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2030-06-01T04:17:00.000Z");
const ago = (days: number) => toStamp(new Date(NOW - days * DAY).toISOString());
const runCron = (vars: Record<string, string> = {}) =>
  worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: "17 4 * * *" }), { ...env, ...vars });

describe("review pruning (cron)", () => {
  it("deletes runs and events older than 90 days, keeping newer ones, and logs nothing", async () => {
    const r = await routine("prune");
    for (const d of [120, 91, 89, 10]) expect((await r.report({ stamp: ago(d), report: reportOf([4700]) })).status).toBe(201);
    const state = (await human.get("/api/state")).body.routines;
    const seq = await maxSeq();
    await runCron();
    const db = await rows(r.id);
    expect(db.runs.map((x) => x.stamp)).toEqual([ago(89), ago(10)]);
    expect(db.events.map((x) => x.stamp)).toEqual([ago(89), ago(10)]); // 4700 acts every run
    expect(await maxSeq()).toBe(seq);
    expect((await human.get("/api/state")).body.routines).toEqual(state);
  });

  it("keeps each routine's newest run and its last finished run, however old", async () => {
    const r = await routine("old");
    await r.report({ stamp: ago(200), report: reportOf([4700]) });
    await r.report({ stamp: ago(150), report: reportOf([4700]) });
    await r.start(ago(100)); // a runner that died mid-run: newest, never finished
    await runCron();
    const db = await rows(r.id);
    expect(db.runs.map((x) => [x.stamp, x.result])).toEqual([
      [ago(150), "ok"], // the head's last_stamp: /api/state's last run
      [ago(100), "running"], // the newest
    ]);
    expect(db.events.map((x) => x.stamp)).toEqual([ago(150)]);
    expect(db.head.last_stamp).toBe(ago(150));
  });

  it("keeps the newest report too, so a late older report after a prune can't bring back a dropped PR", async () => {
    // R1 tracks #1, R3 drops it, R4 finishes without a report: R4 is the newest run and the last_stamp run,
    // R3 the newest report. Pruning R3 would empty the newest-report watermark, and a late R2 would make #1
    // current again.
    const r = await routine("mark");
    await r.report({ stamp: ago(120), report: reportOf([1, 2]) }); // R1
    await r.report({ stamp: ago(100), report: reportOf([2]) }); // R3: #1 gone
    await r.report({ stamp: ago(95), result: "failed", report: null }); // R4
    await runCron();
    expect((await rows(r.id)).runs.map((x) => x.stamp)).toEqual([ago(100), ago(95)]);
    expect((await r.report({ stamp: ago(110), report: reportOf([1, 2]) })).status).toBe(201); // late R2
    const prs = (await rows(r.id)).prs;
    expect(prs.map((p) => [p.number, !!p.gone_at])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("deletes PRs gone for more than 30 days and keeps current ones and recently gone ones", async () => {
    const r = await routine("gone");
    await r.report({ stamp: ago(5), report: reportOf([1, 2, 3]) });
    const goneAt = (n: number, days: number) =>
      env.DB.prepare("UPDATE review_prs SET gone_at = ? WHERE routine = ? AND number = ?").bind(new Date(NOW - days * DAY).toISOString(), r.id, n).run();
    await goneAt(1, 31);
    await goneAt(2, 29);
    await runCron();
    expect((await rows(r.id)).prs.map((p) => p.number)).toEqual([2, 3]);
  });

  it("uses REVIEWS_RETENTION_DAYS, at least 14", async () => {
    const r = await routine("days");
    for (const d of [20, 15, 5]) await r.report({ stamp: ago(d), result: "failed", report: null });
    await runCron({ REVIEWS_RETENTION_DAYS: "14" });
    expect((await rows(r.id)).runs.map((x) => x.stamp)).toEqual([ago(5)]);
    expect(reviewsRetentionDays(undefined)).toBe(90);
    expect(reviewsRetentionDays(" 30 ")).toBe(30);
    for (const bad of ["13", "7", "", "90d", "-1", "1.5"]) expect(() => reviewsRetentionDays(bad), bad).toThrow(/REVIEWS_RETENTION_DAYS/);
  });

  it("a bad REVIEWS_RETENTION_DAYS fails the cron run after the change log was still pruned", async () => {
    await env.DB.prepare("INSERT INTO changes (collection, doc_id, op, actor, at) VALUES ('meta', 'old', 'update', 'test', ?)")
      .bind(new Date(NOW - 60 * DAY).toISOString())
      .run();
    await env.DB.prepare("INSERT INTO changes (collection, doc_id, op, actor, at) VALUES ('meta', 'new', 'update', 'test', ?)")
      .bind(new Date(NOW).toISOString())
      .run();
    await expect(runCron({ REVIEWS_RETENTION_DAYS: "3" })).rejects.toThrow(/REVIEWS_RETENTION_DAYS/);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM changes WHERE doc_id = 'old'").first<{ n: number }>())!.n).toBe(0);
  });

  it("returns what it deleted", async () => {
    const r = await routine("count");
    await r.report({ stamp: ago(100), report: reportOf([4700]) });
    await r.report({ stamp: ago(1), report: reportOf([4700]) });
    expect(await pruneReviews(env.DB, NOW, undefined)).toEqual({ runs: 1, events: 1, prs: 0 });
  });
});
