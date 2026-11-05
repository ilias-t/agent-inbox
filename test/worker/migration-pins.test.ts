// Migration 0010 against a database as it is before it. Every merge to main applies migrations to the live D1
// before the new Worker deploys, so 0010 must only add: no existing object changes, no existing row is read or
// written, nothing is logged, and every write path the live Worker uses keeps logging exactly as before (no new
// trigger on an existing table). Its rollback (dropping pins) must leave nothing behind.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createItem, human, person, setRoles, uid } from "./helpers.ts";
import { reportOf, routine, stamp } from "./reviews-helpers.ts";

const M0010 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0010"))!;

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
  for (const t of ["docs", "changes", "users", "snoozes", "doc_links", "tokens", "push_subscriptions", "review_routines", "review_runs", "review_prs", "review_events"]) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
}

// The rollback in 0010's header.
const rollback = () => env.DB.prepare("DROP TABLE IF EXISTS pins").run();
const migrate = () => env.DB.batch(M0010.queries.map((q) => env.DB.prepare(q)));
const maxSeq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;

describe("migration 0010_pins", () => {
  it("its rollback leaves no trace of it, and re-applying it only adds the pins table, its index and triggers", async () => {
    const full = await schema();
    await rollback();
    const before = await schema();
    expect(before.filter((o) => o.tbl_name === "pins")).toEqual([]);
    expect(full.filter((o) => o.tbl_name !== "pins")).toEqual(before);

    await migrate();
    const after = await schema();
    expect(after).toEqual(full);
    const added = after.filter((o) => !before.some((b) => b.type === o.type && b.name === o.name));
    expect(added.map((o) => [o.type, o.name, o.tbl_name])).toEqual([
      ["index", "pins_target", "pins"],
      ["table", "pins", "pins"],
      ["trigger", "pins_ad", "pins"],
      ["trigger", "pins_ai", "pins"],
    ]);
  });

  it("reads and writes no existing row and logs nothing", async () => {
    const id = uid("m10");
    await createItem(id);
    await human.post(`/api/items/${id}/qa`, { text: "why?" });
    await setRoles({ "you@test": "admin", "m10@team.test": "decider" });
    await person("m10@team.test").post(`/api/items/${id}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() });
    const r = await routine("m10");
    await r.report({ stamp: stamp(0), report: reportOf([1]) });
    await rollback();
    const rows = await data();
    const seq = await maxSeq();
    await migrate();
    expect(await data()).toEqual(rows);
    expect(await maxSeq()).toBe(seq);
  });

  it("every write the live Worker makes still lands, logging one change row as before", async () => {
    const id = uid("m10w"), o = uid("m10o");
    const D = person("m10w@team.test");
    await setRoles({ "you@test": "admin", "m10w@team.test": "decider" });
    const writes: [string, () => Promise<{ status: number }>][] = [
      ["item create", () => human.put(`/api/items/${id}`, { data: { type: "decision", title: "t" } })],
      ["item patch", () => human.patch(`/api/items/${id}`, { data: { summary: "s" } })],
      ["snooze (upsert)", () => D.post(`/api/items/${id}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() })],
      ["decide", () => D.post(`/api/items/${id}/decide`, { choice: "ack" })],
      ["orchestrator", () => human.put(`/api/orchestrators/${o}`, { data: { goal: "g" } })],
      ["batch", () => human.post("/api/batch", { ops: [{ op: "item.archive", id }] })],
      ["item delete", () => human.del(`/api/items/${id}`)],
      ["orchestrator delete", () => human.del(`/api/orchestrators/${o}`)],
    ];
    for (const [name, write] of writes) {
      const seq = await maxSeq();
      const r = await write();
      expect(r.status, name).toBeLessThan(300);
      // Deleting the item drops D's snooze on it too: two rows, as before 0010.
      expect((await maxSeq()) - seq, name).toBe(name === "item delete" ? 2 : 1);
    }
  });
});
