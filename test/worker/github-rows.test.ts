// What the doc_links lookup (migration 0008) saves: a GitHub delivery used to read every item and
// orchestrator, archived ones included. Seeds a deployment at the perf audit's scale (~2.4k items, mostly
// archived, each with a PR link and a CI-run evidence link), delivers one merge, then doubles History and
// delivers another. Prints the D1 rows each delivery read.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { hmacHex } from "../../worker/http.ts";
import worker from "../../worker/index.ts";

const OPEN = 110;
const ARCHIVED = 2290;
const ORCHESTRATORS = 30;
const REPO = "https://github.com/acme/repo";
const STAMP = "2026-01-01T00:00:00.000Z";

async function seedItems(from: number, count: number, status: (i: number) => string) {
  const stmts = [];
  for (let i = from; i < from + count; i++) {
    const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    const data = {
      type: i % 3 === 0 ? "pr_ready" : "decision",
      status: status(i),
      title: `Item ${i}`,
      orchestrator: `O${i % ORCHESTRATORS}`,
      links: [{ label: "PR", url: `${REPO}/pull/${1000 + i}` }],
      evidence: [{ label: "CI run", url: `${REPO}/actions/runs/${90000 + i}` }],
    };
    stmts.push(
      env.DB.prepare(
        "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 1, ?, ?, 'test')",
      ).bind(`seed-${i}`, JSON.stringify(data), at, at),
    );
  }
  for (let k = 0; k < stmts.length; k += 200) await env.DB.batch(stmts.slice(k, k + 200));
}

async function seedOrchestrators() {
  await env.DB.batch(
    Array.from({ length: ORCHESTRATORS }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('orchestrators', ?, ?, 1, ?, ?, 'test')",
      ).bind(`O${i}`, JSON.stringify({ id: `O${i}`, pr: { number: 1000 + i, url: `${REPO}/pull/${1000 + i}` } }), STAMP, STAMP),
    ),
  );
}

// A D1 binding that sums meta.rows_read over every statement it runs (all/first/run and batch).
function counting(db: D1Database) {
  const counter = { rows: 0 };
  const raw = new WeakMap<object, D1PreparedStatement>();
  const add = (r: D1Result) => (counter.rows += r.meta.rows_read ?? 0);
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, prop) {
        if (prop === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (prop === "all" || prop === "run") {
          return async () => {
            const r = await t.all();
            add(r);
            return r;
          };
        }
        if (prop === "first") {
          return async (col?: string) => {
            const r = await t.all<Record<string, unknown>>();
            add(r);
            const row = r.results[0] ?? null;
            return col === undefined ? row : (row?.[col] ?? null);
          };
        }
        return Reflect.get(t, prop, t);
      },
    });
    raw.set(p, s);
    return p;
  };
  const DB = new Proxy(db, {
    get(t, prop) {
      if (prop === "prepare") return (q: string) => wrap(t.prepare(q));
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const results = await t.batch(stmts.map((s) => raw.get(s) ?? s));
          results.forEach(add);
          return results;
        };
      }
      return Reflect.get(t, prop, t);
    },
  });
  return { DB, counter };
}

async function deliver(n: number) {
  const body = JSON.stringify({ action: "closed", pull_request: { html_url: `${REPO}/pull/${n}`, merged: true } });
  const { DB, counter } = counting(env.DB);
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://inbox.test/hooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": `sha256=${await hmacHex(env.GITHUB_WEBHOOK_SECRET!, body)}`,
      },
      body,
    }),
    { ...env, DB },
    ctx,
  );
  const out = (await res.json()) as { updated: unknown[] };
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return { rows: counter.rows, updated: out.updated };
}

it("a delivery reads the docs it matches, not all of History", async () => {
  await seedOrchestrators();
  await seedItems(0, OPEN + ARCHIVED, (i) => (i < OPEN ? "open" : "archived"));
  // seed-3 (an open pr_ready) and orchestrator O3 both link pull/1003.
  const first = await deliver(1003);
  expect(first.updated).toEqual([
    { collection: "items", id: "seed-3" },
    { collection: "orchestrators", id: "O3" },
  ]);

  await seedItems(OPEN + ARCHIVED, OPEN + ARCHIVED, () => "archived");
  const second = await deliver(1004);
  expect(second.updated).toEqual([
    { collection: "items", id: "seed-4" },
    { collection: "orchestrators", id: "O4" },
  ]);

  console.log(
    `GitHub delivery, D1 rows read: ${first.rows} with ${OPEN + ARCHIVED} items, ` +
      `${second.rows} with ${2 * (OPEN + ARCHIVED)} items (${ORCHESTRATORS} orchestrators)`,
  );
  expect(first.rows).toBeLessThan(50);
  expect(second.rows).toBeLessThanOrEqual(first.rows + 5);
});
