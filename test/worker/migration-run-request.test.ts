// Migration 0011 against a database as it is before it. Every merge to main applies migrations to the live D1
// before the new Worker deploys, so 0011 must only add: one nullable column on review_routines, no row read or
// written, nothing logged, and the head's writes (which name their columns) keep landing and logging as before,
// leaving the new column alone. Its rollback (dropping the column) must leave nothing behind.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createItem, human, setRoles, uid } from "./helpers.ts";
import { changesFor, maxSeq, reportOf, routine, stamp } from "./reviews-helpers.ts";

const M0011 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0011"))!;
// 0012 adds review_routines.fleet after run_request and recreates the head's triggers to log it. The database as
// it is before 0011 has neither, so the rollback takes 0012's part on review_routines back first (its triggers as
// 0009 wrote them), and the migration re-applies it after 0011.
const M0009_TRIGGERS = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009"))!.queries.filter((q) => /CREATE TRIGGER review_routines_/.test(q));
const M0012_HEAD = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0012"))!.queries.filter((q) => q.replace(/--.*$/gm, "").includes("review_routines"));

const schema = async () =>
  (
    await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' AND name <> 'd1_migrations' ORDER BY type, name").all<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>()
  ).results;

async function data() {
  const out: Record<string, unknown[]> = {};
  for (const t of ["docs", "changes", "users", "snoozes", "doc_links", "tokens", "push_subscriptions", "pins", "review_routines", "review_runs", "review_prs", "review_events"]) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
}

// The rollback in 0011's header, after 0012's on review_routines.
const rollback = () =>
  env.DB.batch(
    [
      "DROP TRIGGER review_routines_ai",
      "DROP TRIGGER review_routines_au",
      "DROP TRIGGER review_routines_ad",
      "ALTER TABLE review_routines DROP COLUMN fleet",
      ...M0009_TRIGGERS,
      "ALTER TABLE review_routines DROP COLUMN run_request",
    ].map((q) => env.DB.prepare(q)),
  );
const migrate = () => env.DB.batch([...M0011.queries, ...M0012_HEAD].map((q) => env.DB.prepare(q)));
const columns = async () => (await env.DB.prepare("SELECT name FROM pragma_table_info('review_routines') ORDER BY cid").all<{ name: string }>()).results.map((c) => c.name);

describe("migration 0011_review_run_request", () => {
  it("only adds review_routines.run_request; its rollback leaves no trace of it", async () => {
    const full = await schema();
    expect((await columns()).slice(-2)).toEqual(["run_request", "fleet"]);
    await rollback();
    const before = await schema();
    expect(await columns()).not.toContain("run_request");
    // Nothing but review_routines' own definition (and 0012's triggers on it) differs.
    const own = (o: { tbl_name: string }) => o.tbl_name !== "review_routines";
    expect(full.filter(own)).toEqual(before.filter(own));
    await migrate();
    expect(await schema()).toEqual(full);
  });

  it("reads and writes no existing row and logs nothing", async () => {
    await setRoles({ "you@test": "admin" });
    await createItem(uid("m11"));
    const r = await routine("m11");
    await r.report({ stamp: stamp(0), report: reportOf([1]) });
    await rollback();
    const rows = await data();
    const seq = await maxSeq();
    await migrate();
    const after = await data();
    // The one difference: each head row now has run_request, null.
    expect(after.review_routines).toEqual(rows.review_routines.map((h) => ({ ...(h as object), run_request: null, fleet: null })));
    expect({ ...after, review_routines: [] }).toEqual({ ...rows, review_routines: [] });
    expect(await maxSeq()).toBe(seq);
  });

  it("the head's other writes leave a request alone and still log one change row each", async () => {
    await setRoles({ "you@test": "admin" });
    const r = await routine("m11w");
    await r.report({ stamp: stamp(0), report: reportOf([1]) });
    const req = (await human.post(`/api/reviews/${r.id}/run-request`, {})).body.request;
    const writes: [string, () => Promise<{ status: number }>][] = [
      ["start", () => r.start(stamp(10))],
      ["report", () => r.report({ stamp: stamp(10), report: reportOf([1]) })],
      ["report of a failed run", () => r.report({ stamp: stamp(20), result: "failed", report: null })],
    ];
    for (const [name, write] of writes) {
      const n = (await changesFor(r.id)).length;
      expect((await write()).status, name).toBe(201);
      expect((await changesFor(r.id)).length - n, name).toBe(1);
      expect((await human.get(`/api/reviews/${r.id}`)).body.routine.run_request, name).toEqual(req);
    }
  });
});
