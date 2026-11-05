// What GET /api/state/delta saves: an open page used to refetch /api/state?archived=100 on every live change.
// Seeds a deployment at the perf audit's scale (~2.4k items, mostly archived), makes one typical change, and
// compares the two responses, raw and gzipped. Prints the numbers.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { rng } from "./delta-merge.ts";
import { human } from "./helpers.ts";

const OPEN = 110;
const ARCHIVED = 2290;

// Prose-like filler: words from a fixed vocabulary in a seeded order, so it compresses about as well as real
// item text does (the audit measured 327 KB raw / 74 KB gzip).
const R = rng(42);
const VOCAB = Array.from({ length: 400 }, () =>
  Array.from({ length: 2 + R.int(8) }, () => String.fromCharCode(97 + R.int(26))).join(""),
);
const text = (n: number) => Array.from({ length: n }, () => R.pick(VOCAB)).join(" ");

function itemData(i: number, status: string) {
  return {
    type: "decision",
    status,
    title: `Item ${i}: ${text(8)}`,
    summary: text(35),
    question: `${text(14)}?`,
    context: text(50),
    options: ["approve", "reject", "defer"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), description: text(6) })),
    recommendation: { option: "approve", confidence: "medium", why: text(12) },
    priority: "normal",
    source: `O${i % 6}`,
    orchestrator: `O${i % 6}`,
    links: [{ label: "PR", url: `https://github.com/acme/repo/pull/${1000 + i}` }],
    evidence: [{ label: "CI run", url: `https://github.com/acme/repo/actions/runs/${90000 + i}` }],
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    ...(status === "archived" ? { decision: { choice: "approve", decided_at: "2026-02-01T00:00:00.000Z", by: "human:you@test" } } : {}),
  };
}

async function seed() {
  const stmts = [];
  for (let i = 0; i < OPEN + ARCHIVED; i++) {
    const status = i < OPEN ? "open" : "archived";
    const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    stmts.push(
      env.DB.prepare(
        "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 1, ?, ?, 'test')",
      ).bind(`seed-${i}`, JSON.stringify(itemData(i, status)), at, at),
    );
  }
  for (let k = 0; k < stmts.length; k += 200) await env.DB.batch(stmts.slice(k, k + 200));
}

async function gzipLen(s: string): Promise<number> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

// D1 rows a GET reads (summed from each batch result's meta.rows_read).
async function rowsRead(path: string): Promise<number> {
  let rows = 0;
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop !== "batch") return Reflect.get(target, prop, target);
      return async (stmts: D1PreparedStatement[]) => {
        const results = await target.batch(stmts);
        for (const r of results) rows += r.meta.rows_read ?? 0;
        return results;
      };
    },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://localhost${path}`), { ...env, DB }, ctx);
  await res.text();
  await waitOnExecutionContext(ctx);
  return rows;
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

it("a single-item change is a small fraction of the full snapshot", async () => {
  await seed();
  const report: string[] = [];
  const measure = async (label: string, change: () => Promise<{ status: number }>) => {
    const before = (await human.get("/api/state?archived=100")).body.cursor;
    const res = (await change()) as { status: number; body?: unknown };
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const full = JSON.stringify((await human.get("/api/state?archived=100")).body);
    const d = await human.get(`/api/state/delta?since=${before}`);
    expect(d.body).not.toHaveProperty("reset");
    const delta = JSON.stringify(d.body);
    const [fullGz, deltaGz] = [await gzipLen(full), await gzipLen(delta)];
    const [fullRows, deltaRows] = [await rowsRead("/api/state?archived=100"), await rowsRead(`/api/state/delta?since=${before}`)];
    report.push(
      `${label}: /api/state?archived=100 ${kb(full.length)} raw / ${kb(fullGz)} gzip / ${fullRows} D1 rows read; ` +
        `delta ${delta.length} B raw / ${deltaGz} B gzip / ${deltaRows} rows read`,
    );
    expect(deltaRows).toBeLessThan(fullRows / 10);
    expect(delta.length).toBeLessThan(full.length / 50);
  };
  await measure("decide one item", () => human.post("/api/items/seed-3/decide", { choice: "approve" }));
  await measure("ask on one item", () => human.post("/api/items/seed-4/qa", { text: "Which branch?" }));
  await measure("edit one item", () => human.patch("/api/items/seed-5", { data: { priority: "high" } }));
  console.log(`state delta sizes (${OPEN} open + ${ARCHIVED} archived items):\n  ${report.join("\n  ")}`);
});
