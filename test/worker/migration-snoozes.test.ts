// Migration 0007 against a database as it is before it: snoozes live on the item doc
// (data.snoozed_until / data.snoozed_by) and there is no snoozes table. Each test rewinds to that
// state, runs 0007's statements, and checks every live snooze became its snoozer's row while the
// item docs stay exactly as they were.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { person } from "./helpers.ts";

const M0007 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0007"))!;
const HOUR = 3600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const STAMP = "2026-10-01T12:00:00.000Z";

async function rewind(items: Record<string, Record<string, unknown>>) {
  await env.DB.batch([
    env.DB.prepare("DROP TABLE IF EXISTS snoozes"), // drops its triggers too
    env.DB.prepare("DELETE FROM docs WHERE collection = 'items'"),
    ...Object.entries(items).map(([id, data]) =>
      env.DB.prepare(
        `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by)
         VALUES ('items', ?, ?, 4, ?, ?, 'human:you@example.com')`,
      ).bind(id, JSON.stringify({ type: "decision", title: id, status: "open", ...data }), STAMP, STAMP),
    ),
  ]);
}

const migrate = () => env.DB.batch(M0007.queries.map((q) => env.DB.prepare(q)));
const snoozes = async () =>
  (await env.DB.prepare("SELECT item_id, email, until FROM snoozes ORDER BY item_id").all()).results;
const maxSeq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;

describe("migration 0007_snoozes", () => {
  it("moves each future snooze to its snoozer's row, skipping past ones, unattributed ones and closed items", async () => {
    const soon = at(HOUR), later = at(5 * HOUR);
    await rewind({
      future: { snoozed_until: soon, snoozed_by: "human:a@example.com" },
      mixedcase: { snoozed_until: later, snoozed_by: "human:Bob@Example.com" },
      past: { snoozed_until: at(-HOUR), snoozed_by: "human:a@example.com" },
      nobody: { snoozed_until: soon },
      token: { snoozed_until: soon, snoozed_by: "token:mgr" },
      garbage: { snoozed_until: "soon", snoozed_by: "human:a@example.com" },
      decided: { status: "decided", snoozed_until: soon, snoozed_by: "human:a@example.com" },
      plain: {},
    });
    await migrate();
    expect(await snoozes()).toEqual([
      { item_id: "future", email: "a@example.com", until: soon },
      { item_id: "mixedcase", email: "bob@example.com", until: later },
    ]);
  });

  it("normalizes the time and leaves the item docs untouched, logging no changes", async () => {
    const until = new Date(Date.now() + 2 * HOUR);
    until.setUTCMilliseconds(0);
    await rewind({ x: { snoozed_until: until.toISOString().replace(".000Z", "Z"), snoozed_by: "human:a@example.com" } });
    const before = await env.DB.prepare("SELECT data, version, updated_at FROM docs WHERE collection = 'items' AND id = 'x'").first();
    const seq = await maxSeq();
    await migrate();
    expect(await snoozes()).toEqual([{ item_id: "x", email: "a@example.com", until: until.toISOString() }]);
    expect(await env.DB.prepare("SELECT data, version, updated_at FROM docs WHERE collection = 'items' AND id = 'x'").first()).toEqual(before);
    expect(await maxSeq()).toBe(seq);
  });

  it("the snoozer sees the migrated snooze in /api/state and nobody else does", async () => {
    const until = at(HOUR);
    await rewind({ y: { snoozed_until: until, snoozed_by: "human:a@example.com" } });
    await migrate();
    expect((await person("a@example.com").get("/api/state")).body.snoozes).toEqual({ y: until });
    expect((await person("b@example.com").get("/api/state")).body.snoozes).toEqual({});
  });

  it("after it, writes to snoozes go to the change log", async () => {
    await rewind({ z: {} });
    await migrate();
    const seq = await maxSeq();
    await person("a@example.com").post("/api/items/z/snooze", { until: at(HOUR) });
    const row = await env.DB.prepare("SELECT collection, doc_id, op, actor, orchestrator FROM changes WHERE seq > ?").bind(seq).first();
    expect(row).toEqual({ collection: "snoozes", doc_id: "z", op: "create", actor: "human:a@example.com", orchestrator: null });
  });
});
