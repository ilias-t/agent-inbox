// Paging archived items out of /api/state, and the keyset pages and server
// search on GET /api/items that History loads them back with.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Item } from "../../shared/types.ts";
import { agent, human, mintToken } from "./helpers.ts";

// Straight into D1, so updated_at (the paging key) is exactly what the test says.
async function insertItem(id: string, updatedAt: string, data: Partial<Item>): Promise<void> {
  const doc = { type: "decision", title: `Item ${id}`, status: "archived", ...data };
  await env.DB.prepare(
    "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 1, ?, ?, 'test')",
  ).bind(id, JSON.stringify(doc), "2026-01-01T00:00:00.000Z", updatedAt).run();
}

const at = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (docs: { id: string }[]) => docs.map((d) => d.id);

describe("GET /api/state?archived=n", () => {
  const O = "O-state";
  let orch: ReturnType<typeof agent>;
  beforeAll(async () => {
    orch = agent((await mintToken("orchestrator", O)).secret);
    await insertItem("st-open", at(1), { status: "open", orchestrator: O });
    await insertItem("st-decided", at(2), { status: "decided", orchestrator: O });
    await insertItem("st-processing", at(3), { status: "processing", orchestrator: O });
    await insertItem("st-a1", at(10), { orchestrator: O });
    await insertItem("st-a2", at(20), { orchestrator: O });
    await insertItem("st-a3", at(30), { orchestrator: O });
    await insertItem("st-other", at(40), { orchestrator: "O-elsewhere" }); // another orchestrator's
  });

  it("returns every item, archived ones included, without the param", async () => {
    const r = await orch.get("/api/state");
    expect(r.status).toBe(200);
    expect(ids(r.body.items).sort()).toEqual(["st-a1", "st-a2", "st-a3", "st-decided", "st-open", "st-processing"]);
    expect(r.body.archived_total).toBe(3);
    expect(r.body.archived_more).toBe(false);
  });

  it("keeps every non-archived item and only the n most recently updated archived ones", async () => {
    const r = await orch.get("/api/state?archived=2");
    expect(r.status).toBe(200);
    const got = ids(r.body.items);
    expect(got).toEqual(expect.arrayContaining(["st-open", "st-decided", "st-processing", "st-a3", "st-a2"]));
    expect(got).toHaveLength(5);
    expect(r.body.archived_total).toBe(3);
    expect(r.body.archived_more).toBe(true);
  });

  it("says there is no more when n covers every archived item", async () => {
    const r = await orch.get("/api/state?archived=3");
    expect(ids(r.body.items)).toHaveLength(6);
    expect(r.body.archived_more).toBe(false);
  });

  it("returns no archived items for archived=0, with the total", async () => {
    const r = await orch.get("/api/state?archived=0");
    expect(ids(r.body.items).sort()).toEqual(["st-decided", "st-open", "st-processing"]);
    expect(r.body.archived_total).toBe(3);
    expect(r.body.archived_more).toBe(true);
  });

  it("counts every orchestrator's archived items for a human", async () => {
    const r = await human.get("/api/state?archived=1");
    expect(r.status).toBe(200);
    expect(r.body.archived_total).toBe(4);
    expect(ids(r.body.items)).toContain("st-other"); // the newest archived
    expect(ids(r.body.items)).not.toContain("st-a3");
  });

  it.each(["-1", "1.5", "abc", "", "1001"])("rejects archived=%j", async (v) => {
    const r = await orch.get(`/api/state?archived=${v}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_request");
  });
});

describe("GET /api/items keyset pages", () => {
  const O = "O-page";
  beforeAll(async () => {
    // p-c, p-b and p-a share one timestamp, so a page edge falls between them.
    await insertItem("p-e", at(50), { orchestrator: O });
    await insertItem("p-d", at(40), { orchestrator: O });
    await insertItem("p-c", at(30), { orchestrator: O });
    await insertItem("p-b", at(30), { orchestrator: O });
    await insertItem("p-a", at(30), { orchestrator: O });
    await insertItem("p-z", at(10), { orchestrator: O });
    await insertItem("p-open", at(59), { orchestrator: O, status: "open" });
  });
  const page = (qs: string) => human.get(`/api/items?status=archived&orchestrator=${O}&${qs}`);

  it("returns the newest first, ties broken by id descending, and says whether there is more", async () => {
    const r = await page("limit=3");
    expect(r.status).toBe(200);
    expect(ids(r.body.items)).toEqual(["p-e", "p-d", "p-c"]);
    expect(r.body.more).toBe(true);
  });

  it("continues strictly after the (updated_at, id) cursor, across equal timestamps", async () => {
    const r = await page(`limit=3&before=${encodeURIComponent(at(30))}&before_id=p-c`);
    expect(ids(r.body.items)).toEqual(["p-b", "p-a", "p-z"]);
    expect(r.body.more).toBe(false);
  });

  it("walks every archived item exactly once at page size 2", async () => {
    const seen: string[] = [];
    let qs = "limit=2";
    for (let i = 0; i < 10; i++) {
      const r = await page(qs);
      seen.push(...ids(r.body.items));
      if (!r.body.more) break;
      const last = r.body.items[r.body.items.length - 1];
      qs = `limit=2&before=${encodeURIComponent(last.updated_at)}&before_id=${encodeURIComponent(last.id)}`;
    }
    expect(seen).toEqual(["p-e", "p-d", "p-c", "p-b", "p-a", "p-z"]);
  });

  it("with before alone, skips everything at or after that time", async () => {
    const r = await page(`limit=10&before=${encodeURIComponent(at(30))}`);
    expect(ids(r.body.items)).toEqual(["p-z"]);
  });

  it("keeps the old order and no limit when neither limit nor before is given", async () => {
    const r = await page("");
    expect(r.body.more).toBeUndefined();
    expect(ids(r.body.items)).toHaveLength(6);
  });

  it.each([
    ["limit=0"],
    ["limit=201"],
    ["limit=x"],
    ["before=yesterday"],
    ["before_id=p-c"],
  ])("rejects %s", async (qs) => {
    const r = await page(qs);
    expect(r.status).toBe(400);
  });
});

describe("GET /api/items?q= search", () => {
  const O = "O-search";
  beforeAll(async () => {
    await insertItem("s-title", at(1), { orchestrator: O, title: "Postgres or SQLite?" });
    await insertItem("s-summary", at(2), { orchestrator: O, summary: "The e2e suite times out" });
    await insertItem("s-question", at(3), { orchestrator: O, question: "Rename the Billing module?" });
    await insertItem("s-note", at(4), {
      orchestrator: O,
      decision: { choice: "pg", note: "Go with managed Postgres", decided_at: at(4), by: "human:you@test" },
    });
    await insertItem("s-pct", at(5), { orchestrator: O, title: "Cut costs by 50% this quarter" });
    await insertItem("s-under", at(6), { orchestrator: O, title: "Rename user_id to account_id" });
    await insertItem("s-plain", at(7), { orchestrator: O, title: "Cut costs by 500 dollars, user id cleanup" });
    await insertItem("s-slash", at(8), { orchestrator: O, title: "Path a\\b fix" });
  });
  const search = (q: string, extra = "") =>
    human.get(`/api/items?status=archived&orchestrator=${O}&limit=50&q=${encodeURIComponent(q)}${extra}`);

  it("matches the title, summary, question, decision note and orchestrator id, case-insensitively", async () => {
    expect(ids((await search("POSTGRES")).body.items)).toEqual(["s-note", "s-title"]);
    expect(ids((await search("e2e")).body.items)).toEqual(["s-summary"]);
    expect(ids((await search("billing")).body.items)).toEqual(["s-question"]);
    expect(ids((await search("managed")).body.items)).toEqual(["s-note"]);
    expect(ids((await search("o-search")).body.items)).toHaveLength(8);
  });

  it("needs every word to match somewhere", async () => {
    expect(ids((await search("sqlite postgres")).body.items)).toEqual(["s-title"]);
    expect(ids((await search("sqlite billing")).body.items)).toEqual([]);
  });

  it("treats LIKE wildcards in the query as literal characters", async () => {
    expect(ids((await search("50%")).body.items)).toEqual(["s-pct"]);
    expect(ids((await search("user_id")).body.items)).toEqual(["s-under"]);
    expect(ids((await search("a\\b")).body.items)).toEqual(["s-slash"]);
    expect(ids((await search("%")).body.items)).toEqual(["s-pct"]);
  });

  it("works with the keyset cursor", async () => {
    const r = await search("cut", "&before=" + encodeURIComponent(at(7)) + "&before_id=s-plain");
    expect(ids(r.body.items)).toEqual(["s-pct"]);
  });

  it("rejects a query over 200 characters", async () => {
    const r = await search("x".repeat(201));
    expect(r.status).toBe(400);
  });

  it("ignores a blank query", async () => {
    expect(ids((await search("   ")).body.items)).toHaveLength(8);
  });
});

describe("orchestrator tokens on the new params", () => {
  let orch: ReturnType<typeof agent>;
  const O = "O-own";
  beforeAll(async () => {
    orch = agent((await mintToken("orchestrator", O)).secret);
    await insertItem("own-1", at(1), { orchestrator: O, title: "shared word" });
    await insertItem("own-2", at(2), { orchestrator: O, title: "shared word" });
    await insertItem("foreign-1", at(3), { orchestrator: "O-foreign", title: "shared word" });
  });

  it("pages and searches only their own items, whatever the query asks for", async () => {
    const r = await orch.get("/api/items?status=archived&orchestrator=O-foreign&limit=10&q=shared");
    expect(r.status).toBe(200);
    expect(ids(r.body.items)).toEqual(["own-2", "own-1"]);
    const next = await orch.get(`/api/items?status=archived&limit=10&before=${encodeURIComponent(at(9))}&q=shared`);
    expect(ids(next.body.items)).toEqual(["own-2", "own-1"]);
  });

  it("counts only their own archived items in /api/state", async () => {
    const r = await orch.get("/api/state?archived=1");
    expect(ids(r.body.items)).toEqual(["own-2"]);
    expect(r.body.archived_total).toBe(2);
    expect(r.body.archived_more).toBe(true);
  });

  it("can't find another orchestrator's item through search", async () => {
    const r = await orch.get("/api/items?q=O-foreign");
    expect(r.body.items).toEqual([]);
  });
});
