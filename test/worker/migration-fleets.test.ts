// Migration 0012 against a database as it is before it. Every merge to main applies migrations to the live D1
// before the new Worker deploys, so 0012 must only add: nullable columns and indexes, and the six change-log
// triggers recreated to log one more column. No existing row is read into a new value or written, nothing is
// logged, and the rollback in its header leaves the schema exactly as 0011 left it. Its triggers record each
// change's fleet at write time.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createItem, human, mintToken, setRoles, uid } from "./helpers.ts";
import { maxSeq, reportOf, routine, stamp } from "./reviews-helpers.ts";

const M0012 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0012"))!;
const triggersOf = (prefix: string, table: string) =>
  env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix))!.queries.filter((q) => new RegExp(`CREATE TRIGGER ${table}_a[iud]\\b`).test(q));

const schema = async () =>
  (
    await env.DB.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' AND name <> 'd1_migrations' ORDER BY type, name",
    ).all<{ type: string; name: string; tbl_name: string; sql: string | null }>()
  ).results;

const TABLES = ["docs", "changes", "users", "snoozes", "doc_links", "tokens", "push_subscriptions", "pins", "review_routines", "review_runs", "review_prs", "review_events"];
async function data() {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all<Record<string, unknown>>()).results;
  return out;
}

// The rollback in 0012's header, in its order: indexes, the triggers as 0002 and 0009 wrote them, the columns.
const rollback = () =>
  env.DB.batch(
    [
      "DROP INDEX docs_fleet",
      "DROP INDEX changes_fleet",
      ...["docs_ai", "docs_au", "docs_ad", "review_routines_ai", "review_routines_au", "review_routines_ad"].map((t) => `DROP TRIGGER ${t}`),
      ...triggersOf("0002", "docs"),
      ...triggersOf("0009", "review_routines"),
      "ALTER TABLE docs DROP COLUMN fleet",
      "ALTER TABLE changes DROP COLUMN fleet",
      "ALTER TABLE tokens DROP COLUMN fleet",
      "ALTER TABLE review_routines DROP COLUMN fleet",
    ].map((q) => env.DB.prepare(q)),
  );
const migrate = () => env.DB.batch(M0012.queries.map((q) => env.DB.prepare(q)));

describe("migration 0012_fleets", () => {
  it("its rollback leaves no trace of it, and re-applying it gives the same schema", async () => {
    const full = await schema();
    await rollback();
    const before = await schema();
    expect(JSON.stringify(before)).not.toMatch(/fleet/);
    // Only the four tables, their triggers and the two indexes differ.
    const touched = new Set(["docs", "changes", "tokens", "review_routines"]);
    expect(full.filter((o) => !touched.has(o.tbl_name))).toEqual(before.filter((o) => !touched.has(o.tbl_name)));
    await migrate();
    expect(await schema()).toEqual(full);
  });

  it("writes no existing row and logs nothing: every row is the default fleet", async () => {
    await setRoles({ "you@test": "admin" });
    const id = uid("m12");
    await createItem(id);
    await human.post(`/api/items/${id}/qa`, { text: "q" });
    await human.put(`/api/orchestrators/${uid("O")}`, { data: {} });
    await human.put("/api/meta/manager", { data: { note: "n" } });
    await mintToken("manager");
    const r = await routine("m12");
    await r.report({ stamp: stamp(0), report: reportOf([1]) });
    await rollback();
    const rows = await data();
    const seq = await maxSeq();
    await migrate();
    const after = await data();
    const withFleet = (t: string) => rows[t].map((row) => ({ ...row, fleet: null }));
    expect(after).toEqual({
      ...rows,
      docs: withFleet("docs"),
      changes: withFleet("changes"),
      tokens: withFleet("tokens"),
      review_routines: withFleet("review_routines"),
    });
    expect(await maxSeq()).toBe(seq);
  });

  it("logs each change's fleet: an item's or manager's own, a qa message's item's, a per-fleet meta doc's, a fleet doc's id; a move also under the fleet it left", async () => {
    const now = new Date().toISOString();
    const item = uid("m12i"), plain = uid("m12p"), orch = uid("m12o");
    const ins = (collection: string, id: string, data: unknown) =>
      env.DB.prepare("INSERT INTO docs (collection, id, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'test')").bind(
        collection,
        id,
        JSON.stringify(data),
        now,
        now,
      );
    const seq = await maxSeq();
    await env.DB.batch([
      ins("items", item, { type: "info", title: "t", fleet: "side-a" }),
      ins(`items/${item}/qa`, "m-1", { role: "user", text: "q" }),
      ins("items", plain, { type: "info", title: "t" }),
      ins("orchestrators", orch, { fleet: "side-b" }),
      ins("meta", "manager:side-a", {}),
      ins("meta", `${uid("plain")}`, {}),
      ins("meta", `notes:${uid("v")}`, {}),
      ins("meta", "schedule:default", {}),
      ins("fleets", "side-a", {}),
      ins("fleets", "default", {}),
    ]);
    await env.DB.prepare("UPDATE docs SET data = json_set(data, '$.fleet', 'side-c') WHERE collection = 'items' AND id = ?").bind(item).run();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM docs WHERE collection = ?").bind(`items/${item}/qa`),
      env.DB.prepare("DELETE FROM docs WHERE collection = 'items' AND id = ?").bind(item),
    ]);
    const logged = (
      await env.DB.prepare("SELECT collection, op, fleet FROM changes WHERE seq > ? ORDER BY seq").bind(seq).all<{ collection: string; op: string; fleet: string | null }>()
    ).results.map((r) => `${r.op} ${r.collection.replace(item, "<i>")} ${r.fleet}`);
    expect(logged).toEqual([
      "create items side-a",
      "create items/<i>/qa side-a",
      "create items null",
      "create orchestrators side-b",
      "create meta side-a",
      "create meta null",
      "create meta null",
      "create meta null",
      "create fleets side-a",
      "create fleets null",
      "update items side-a",
      "update items side-c",
      "delete items/<i>/qa side-c",
      "delete items side-c",
    ]);
  });
});
