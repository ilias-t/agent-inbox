import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { pruneChanges, retentionDays } from "../../worker/prune.ts";
import { createItem, human, uid } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2030-06-01T04:17:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const seqs = async () =>
  (await env.DB.prepare("SELECT seq FROM changes ORDER BY seq").all<{ seq: number }>()).results.map((r) => r.seq);

// One change row per item, then backdate each to its given age in days.
async function changesAged(...ages: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const age of ages) {
    await createItem(uid("pr"));
    const seq = Math.max(...(await seqs()));
    await env.DB.prepare("UPDATE changes SET at = ? WHERE seq = ?").bind(ago(age), seq).run();
    out.push(seq);
  }
  return out;
}

// The handler awaits the prune itself (no waitUntil), so this resolves after it.
const runCron = (vars: Record<string, string> = {}) =>
  worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: "17 4 * * *" }), { ...env, ...vars });

// Each test starts from an empty log; seq keeps counting (AUTOINCREMENT).
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM changes").run();
});

describe("change log pruning (cron)", () => {
  it("deletes changes older than 30 days by default and keeps newer ones", async () => {
    const [old1, old2, fresh1, fresh2] = await changesAged(45, 31, 29, 1);
    await runCron();
    expect(await seqs()).toEqual([fresh1, fresh2]);
    expect(await seqs()).not.toContain(old1);
    expect(await seqs()).not.toContain(old2);
  });

  it("uses CHANGES_RETENTION_DAYS when set", async () => {
    const [, , fresh] = await changesAged(20, 10, 5);
    await runCron({ CHANGES_RETENTION_DAYS: "7" });
    expect(await seqs()).toEqual([fresh]);
  });

  it("always keeps the newest change, so the cursor never goes backwards", async () => {
    const [, , newest] = await changesAged(90, 60, 40);
    const before = (await human.get("/api/changes")).body.cursor;
    expect(before).toBe(newest);
    await runCron();
    expect(await seqs()).toEqual([newest]);
    expect((await human.get("/api/changes")).body.cursor).toBe(newest);
    expect((await human.get("/api/state")).body.cursor).toBe(newest);
    // A caught-up client still sees "nothing new" at its own cursor.
    expect((await human.get(`/api/changes?since=${newest}`)).body).toEqual({ cursor: newest, changes: [] });
  });

  it("gives a cursor older than the oldest retained change the retained changes after it", async () => {
    const [stale, , kept] = await changesAged(60, 40, 2);
    await runCron();
    const r = await human.get(`/api/changes?since=${stale}`);
    expect(r.body.changes.map((c: any) => c.seq)).toEqual([kept]);
    expect(r.body.cursor).toBe(kept);
  });

  it("keeps seq monotonic after the log is emptied", async () => {
    const [, last] = await changesAged(60, 40);
    await env.DB.prepare("DELETE FROM changes").run();
    await createItem(uid("after"));
    const [next] = await seqs();
    expect(next).toBeGreaterThan(last);
  });

  it("rejects an invalid or too-short CHANGES_RETENTION_DAYS and deletes nothing", async () => {
    const all = await changesAged(60, 40);
    for (const bad of ["6", "0", "-30", "abc", "7.5", ""]) {
      await expect(runCron({ CHANGES_RETENTION_DAYS: bad })).rejects.toThrow(/CHANGES_RETENTION_DAYS/);
    }
    expect(await seqs()).toEqual(all);
  });
});

describe("retentionDays", () => {
  it("defaults to 30 and accepts whole numbers of days from 7", () => {
    expect(retentionDays(undefined)).toBe(30);
    expect(retentionDays("7")).toBe(7);
    expect(retentionDays(" 90 ")).toBe(90);
  });
});

describe("pruneChanges", () => {
  it("deletes in bounded batches until nothing old is left", async () => {
    const [, , , , , fresh] = await changesAged(50, 49, 48, 47, 46, 1);
    const r = await pruneChanges(env.DB, { cutoff: ago(30), batch: 2, maxBatches: 10 });
    expect(r).toEqual({ deleted: 5, done: true });
    expect(await seqs()).toEqual([fresh]);
  });

  it("stops after maxBatches and leaves the rest for the next run", async () => {
    const aged = await changesAged(50, 49, 48, 47, 46, 1);
    const r = await pruneChanges(env.DB, { cutoff: ago(30), batch: 2, maxBatches: 2 });
    expect(r).toEqual({ deleted: 4, done: false });
    expect(await seqs()).toEqual(aged.slice(4));
  });
});
