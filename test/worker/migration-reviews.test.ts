// Migration 0009 against a database as it is before it. Every merge to main applies migrations to the live D1
// before the new Worker deploys, so 0009 must only add: no existing object changes, no existing row is read or
// written, nothing is logged, and every write path the live Worker uses keeps working (and keeps logging
// exactly as before: no new trigger on an existing table). Its rollback (dropping the four tables) must leave
// nothing behind.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createItem, human, person, setRoles, uid } from "./helpers.ts";

const M0009 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009"))!;
// Later migrations that change the review tables, re-applied after 0009 so the schema matches the suite's again.
const LATER = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0011"));
const REVIEW_TABLES = ["review_events", "review_prs", "review_runs", "review_routines"];

const schema = async () =>
  (
    await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' AND name <> 'd1_migrations' ORDER BY type, name").all<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>()
  ).results;

// Every row of the tables the live Worker writes, to compare before and after.
async function data() {
  const out: Record<string, unknown[]> = {};
  for (const t of ["docs", "changes", "users", "snoozes", "doc_links", "tokens", "push_subscriptions"]) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
}

// The rollback in 0009's header: drop its tables (their triggers and indexes go with them).
const rollback = () => env.DB.batch(REVIEW_TABLES.map((t) => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
const migrate = () => env.DB.batch([M0009, ...LATER].flatMap((m) => m.queries.map((q) => env.DB.prepare(q))));
const maxSeq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;

describe("migration 0009_reviews", () => {
  it("its rollback leaves no trace of it, and re-applying it only adds review_* objects", async () => {
    const full = await schema();
    await rollback();
    const before = await schema();
    expect(before.filter((o) => o.tbl_name.startsWith("review_"))).toEqual([]);
    expect(full.filter((o) => !o.tbl_name.startsWith("review_"))).toEqual(before);

    await migrate();
    const after = await schema();
    expect(after).toEqual(full);
    // Every object that was there is there unchanged; everything new belongs to a review table.
    for (const o of before) expect(after).toContainEqual(o);
    const added = after.filter((o) => !before.some((b) => b.type === o.type && b.name === o.name));
    expect(added.length).toBeGreaterThan(0);
    for (const o of added) expect(REVIEW_TABLES, `${o.type} ${o.name} on ${o.tbl_name}`).toContain(o.tbl_name);
    // Its triggers are on its head table only, and write only to changes.
    const triggers = added.filter((o) => o.type === "trigger");
    expect(triggers.map((t) => t.tbl_name)).toEqual(["review_routines", "review_routines", "review_routines"]);
  });

  it("reads and writes no existing row and logs nothing", async () => {
    await rollback();
    const id = uid("m9");
    await createItem(id, { links: [{ label: "PR", url: "https://github.com/acme/widgets/pull/1" }] });
    await human.post(`/api/items/${id}/qa`, { text: "why?" });
    await setRoles({ "you@test": "admin", "m9@team.test": "decider" });
    await person("m9@team.test").post(`/api/items/${id}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() });
    const rows = await data();
    const seq = await maxSeq();
    await migrate();
    expect(await data()).toEqual(rows);
    expect(await maxSeq()).toBe(seq);
  });

  it("every write the live Worker makes still lands, logging one change row as before", async () => {
    // The whole suite runs migrated; this pins the existing write paths, upserts (ON CONFLICT DO UPDATE)
    // included, to one change row each, so 0009 can't have added a trigger that fires (or fails) on them.
    const id = uid("m9w");
    const D = person("m9w@team.test");
    await setRoles({ "you@test": "admin", "m9w@team.test": "decider" });
    const writes: [string, () => Promise<{ status: number }>][] = [
      ["item create", () => human.put(`/api/items/${id}`, { data: { type: "decision", title: "t" } })],
      ["item patch", () => human.patch(`/api/items/${id}`, { data: { summary: "s" } })],
      ["question", () => D.post(`/api/items/${id}/qa`, { text: "q" })],
      ["snooze (upsert)", () => D.post(`/api/items/${id}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() })],
      ["snooze again (upsert's update)", () => D.post(`/api/items/${id}/snooze`, { until: new Date(Date.now() + 2 * 86_400_000).toISOString() })],
      ["decide", () => D.post(`/api/items/${id}/decide`, { choice: "ack" })],
      ["user role (upsert's update)", () => human.put("/api/users/m9w@team.test", { role: "viewer" })],
      ["orchestrator", () => human.put(`/api/orchestrators/${id}`, { data: { pr: { url: "https://github.com/acme/widgets/pull/2" } } })],
      ["meta", () => human.put("/api/meta/manager", { data: { digest: "d" } })],
      ["batch", () => human.post("/api/batch", { ops: [{ op: "item.archive", id }] })],
    ];
    for (const [name, write] of writes) {
      const seq = await maxSeq();
      const r = await write();
      expect(r.status, name).toBeLessThan(300);
      // A question writes the qa message and bumps the item: two docs, two rows, as before 0009.
      expect((await maxSeq()) - seq, name).toBe(name === "question" ? 2 : 1);
    }
  });
});
