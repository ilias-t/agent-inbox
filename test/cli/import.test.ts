import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  ISO_RE,
  buildImportSql,
  normalizeExport,
  readExportDir,
  scheduleFromManager,
  shiftTimestamps,
} from "../../scripts/lib/import.mjs";
import { isValidCollection } from "../../scripts/lib/ids.mjs";
import { sqlString } from "../../scripts/lib/sql.mjs";
import { seedExport } from "../../scripts/seed.mjs";

const NOW = "2026-10-07T12:00:00.000Z";

// Pulls the data JSON back out of one generated INSERT, undoing the SQL quoting.
function dataOf(statement: string): unknown {
  const m = /VALUES \('(?:[^']|'')*', '(?:[^']|'')*', '((?:[^']|'')*)'/.exec(statement);
  if (!m) throw new Error(`no data literal in: ${statement}`);
  return JSON.parse(m[1].replaceAll("''", "'"));
}

describe("normalizeExport", () => {
  const item = { id: "p-1", version: 3, data: { type: "proposal", title: "T", status: "open" } };

  it("reads the collections map", () => {
    const docs = normalizeExport({ items: [item], "items/p-1/qa": [{ id: "m-1", data: { role: "user", text: "q" } }] });
    expect(docs).toEqual([
      { collection: "items", id: "p-1", version: 3, data: item.data, created_at: undefined, updated_at: undefined },
      { collection: "items/p-1/qa", id: "m-1", version: undefined, data: { role: "user", text: "q" }, created_at: undefined, updated_at: undefined },
    ]);
  });

  it("reads {collections: {...}} the same way", () => {
    expect(normalizeExport({ collections: { items: [item] } })).toEqual(normalizeExport({ items: [item] }));
  });

  it("reads a flat array of {collection, id, data, version}", () => {
    const docs = normalizeExport([{ collection: "meta", id: "manager", version: 2, data: { digest: "d" } }]);
    expect(docs[0]).toMatchObject({ collection: "meta", id: "manager", version: 2, data: { digest: "d" } });
  });

  it("accepts flat documents and objects keyed by id", () => {
    const docs = normalizeExport({ orchestrators: { O1: { goal: "g", status: "running", version: 5 } } });
    expect(docs[0]).toMatchObject({ collection: "orchestrators", id: "O1", version: 5, data: { goal: "g", status: "running" } });
  });

  it("reads an ArtifactData out_dir tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-export-"));
    try {
      mkdirSync(join(dir, "items", "p-1", "qa"), { recursive: true });
      writeFileSync(join(dir, "items", "p-1.json"), JSON.stringify(item));
      writeFileSync(join(dir, "items", "p-1", "qa", "m-1.json"), JSON.stringify({ role: "user", text: "q" }));
      const docs = readExportDir(dir);
      expect(docs.map((d) => `${d.collection}/${d.id}`).sort()).toEqual(["items/p-1", "items/p-1/qa/m-1"]);
      expect(docs.find((d) => d.id === "m-1")?.data).toEqual({ role: "user", text: "q" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildImportSql", () => {
  it("escapes quotes and keeps newlines, unicode and nested JSON intact", () => {
    const data = {
      type: "info",
      title: `it's "quoted"; DROP TABLE docs; -- not a comment`,
      context: "line 1\nline 2;\n'single' ''double''\n/* x */",
      emoji: "héllo 🚀 日本",
      nested: { a: [1, { b: "c'd" }], nil: null },
      status: "open",
    };
    const { statements } = buildImportSql([{ collection: "items", id: "it's-bad", data }, { collection: "items", id: "ok-1", data }], { now: NOW });
    expect(statements).toHaveLength(1);
    expect(dataOf(statements[0])).toEqual(data);
    expect(statements[0]).toContain("'import:artifact'");
    expect(statements[0]).toMatch(/ON CONFLICT \(collection, id\) DO NOTHING;$/);
  });

  it("rejects NUL in SQL strings", () => {
    expect(() => sqlString("a\0b")).toThrow(/NUL/);
  });

  it("keeps version and timestamps; defaults them when missing", () => {
    const { docs } = buildImportSql(
      [
        { collection: "items", id: "a", version: 7, data: { title: "A", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" } },
        { collection: "items", id: "b", data: { title: "B" } },
      ],
      { now: NOW },
    );
    expect(docs[0]).toMatchObject({ id: "a", version: 7, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" });
    expect(docs[1]).toMatchObject({ id: "b", version: 1, created_at: NOW, updated_at: NOW });
  });

  it("upserts with replace", () => {
    const { statements } = buildImportSql([{ collection: "items", id: "a", data: { title: "A" } }], { replace: true, now: NOW });
    expect(statements[0]).toContain("DO UPDATE SET data = excluded.data, version = excluded.version");
  });

  it("forces orchestrators' data.id to the doc id", () => {
    const { docs } = buildImportSql([{ collection: "orchestrators", id: "O2", data: { id: "wrong", goal: "g" } }], { now: NOW });
    expect(docs[0].data).toEqual({ id: "O2", goal: "g" });
  });

  it("skips bad ids, bad collections, non-object data and duplicates", () => {
    const { docs, skipped } = buildImportSql(
      [
        { collection: "items", id: "-starts-with-dash", data: {} },
        { collection: "items", id: "x".repeat(129), data: {} },
        { collection: "items", id: "has space", data: {} },
        { collection: "widgets", id: "w1", data: {} },
        { collection: "items/bad id/qa", id: "m1", data: {} },
        { collection: "items", id: "arr", data: [1] },
        { collection: "items", id: "dup", data: { title: "first" } },
        { collection: "items", id: "dup", data: { title: "second" } },
      ],
      { now: NOW },
    );
    expect(skipped.map((s) => s.reason)).toEqual([
      "invalid id",
      "invalid id",
      "invalid id",
      "invalid collection",
      "invalid collection",
      "data is not an object",
      "duplicate (last one wins)",
    ]);
    expect(docs.map((d) => [d.id, d.data])).toEqual([["dup", { title: "second" }]]);
  });

  it("skips meta/lease unless withLease", () => {
    const lease = { collection: "meta", id: "lease", data: { holder_session_id: "s" } };
    expect(buildImportSql([lease], { now: NOW }).docs).toHaveLength(0);
    expect(buildImportSql([lease], { now: NOW }).skipped[0].reason).toMatch(/with-lease/);
    expect(buildImportSql([lease], { withLease: true, now: NOW }).docs).toHaveLength(1);
  });

  it("derives meta/schedule from meta/manager's legacy fields when absent", () => {
    const manager = { collection: "meta", id: "manager", data: { digest: "d", timezone: "Europe/Paris", pickup_interval_min: 15 } };
    const { docs, derived } = buildImportSql([manager], { now: NOW });
    expect(derived).toEqual([{ collection: "meta", id: "schedule", from: "meta/manager" }]);
    expect(docs.find((d) => d.id === "schedule")?.data).toEqual({ ...DEFAULT_SCHEDULE, timezone: "Europe/Paris", pickup_interval_min: 15 });
  });

  it("keeps an exported meta/schedule over the derived one, and derives nothing without legacy fields", () => {
    const manager = { collection: "meta", id: "manager", data: { timezone: "Europe/Paris" } };
    const schedule = { collection: "meta", id: "schedule", data: { ...DEFAULT_SCHEDULE } };
    expect(buildImportSql([manager, schedule], { now: NOW }).derived).toEqual([]);
    expect(scheduleFromManager({ digest: "only" })).toBeNull();
  });

  it("counts docs per collection with qa grouped", () => {
    const { counts } = buildImportSql(
      normalizeExport({ items: [{ id: "a", data: { title: "A" } }], "items/a/qa": [{ id: "m1", data: {} }, { id: "m2", data: {} }] }),
      { now: NOW },
    );
    expect(counts).toEqual({ items: 1, "items/*/qa": 2 });
  });
});

describe("ids", () => {
  it("validates collection names", () => {
    expect(["items", "orchestrators", "meta", "items/O3-x/qa"].every(isValidCollection)).toBe(true);
    expect(["tokens", "items/", "items/a/b/qa", "meta/x"].some(isValidCollection)).toBe(false);
  });
});

describe("seed fixture", () => {
  it("covers every item type and status, a pending qa thread and an expired lease", () => {
    const exp = seedExport(Date.parse(NOW));
    const { docs, skipped } = buildImportSql(normalizeExport(exp), { replace: true, withLease: true, now: NOW });
    expect(skipped).toEqual([]);
    const items = docs.filter((d) => d.collection === "items").map((d) => d.data as Record<string, unknown>);
    expect(new Set(items.map((i) => i.type))).toEqual(new Set(["proposal", "decision", "pr_ready", "blocker", "info", "auto_decided"]));
    expect(new Set(items.map((i) => i.status))).toEqual(new Set(["open", "decided", "processing", "archived"]));
    expect(items.some((i) => i.qa_pending === true)).toBe(true);
    const meta = Object.fromEntries(docs.filter((d) => d.collection === "meta").map((d) => [d.id, d.data as Record<string, string>]));
    expect(Object.keys(meta).sort()).toEqual(["lease", "manager", "schedule"]);
    expect(Date.parse(meta.lease.expires_at)).toBeLessThan(Date.parse(NOW));
    expect(Date.parse(meta.manager.next_tick)).toBeGreaterThan(Date.parse(NOW));
  });

  it("puts every seeded timestamp in the past (except next_tick), in a sensible order", () => {
    const now = Date.parse(NOW);
    const exp = seedExport(now);
    const late: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === "string" && ISO_RE.test(v) && !path.endsWith(".next_tick") && Date.parse(v) > now) late.push(`${path}=${v}`);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(exp, "");
    expect(late).toEqual([]);

    const { docs } = buildImportSql(normalizeExport(exp), { replace: true, withLease: true, now: NOW });
    expect(docs.every((d) => Date.parse(d.created_at) <= now && Date.parse(d.updated_at) <= now)).toBe(true);
    const items = new Map(docs.filter((d) => d.collection === "items").map((d) => [d.id, d.data as Record<string, any>]));
    for (const [id, item] of items) {
      const created = Date.parse(item.created_at);
      expect(created, id).toBeLessThanOrEqual(Date.parse(item.updated_at));
      if (item.decision) {
        const decided = Date.parse(item.decision.decided_at);
        expect(decided, id).toBeGreaterThanOrEqual(created);
        expect(decided, id).toBeLessThanOrEqual(Date.parse(item.updated_at));
      }
    }
    for (const d of docs.filter((x) => x.collection.endsWith("/qa"))) {
      const item = items.get(d.collection.split("/")[1])!;
      expect(Date.parse((d.data as { created_at: string }).created_at)).toBeGreaterThanOrEqual(Date.parse(item.created_at));
    }
  });

  it("shiftTimestamps moves ISO strings only", () => {
    expect(shiftTimestamps({ a: "2026-01-01T00:00:00.000Z", b: ["2026-01-01T00:00:00Z", "x"], c: 1 }, 60_000)).toEqual({
      a: "2026-01-01T00:01:00.000Z",
      b: ["2026-01-01T00:01:00.000Z", "x"],
      c: 1,
    });
  });
});
