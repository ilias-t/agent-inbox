// Shared by the global setup and the tests: where the e2e D1 lives, how to run wrangler quietly
// against it, and how to put it back to the seed data. The suite owns this persist dir; the
// developer's .wrangler/state is never touched.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildImportSql, normalizeExport } from "../../scripts/lib/import.mjs";
import { REPO_ROOT } from "../../scripts/lib/wrangler.mjs";
import { seedExport } from "../../scripts/seed.mjs";

export const ROOT: string = REPO_ROOT;
export const PERSIST_TO = resolve(ROOT, ".wrangler/e2e");
export const SERVER_LOG = resolve(PERSIST_TO, "wrangler.log");
export const WRANGLER = resolve(ROOT, "node_modules/.bin/wrangler");
// Every wrangler command here passes this committed test config, so the suite never reads a deployment's wrangler.jsonc.
export const WRANGLER_CONFIG = resolve(ROOT, "wrangler.test.jsonc");
export const QUIET_ENV = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };

// Runs a command from the repo root with its output captured; throws with that output on failure.
export function run(cmd: string, args: string[], what: string): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: QUIET_ENV, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error("e2e: " + what + " failed (exit " + r.status + ")\n" + r.stdout + r.stderr);
  return r.stdout;
}

// Every doc, snooze and review routine goes, then the sample data (scripts/fixtures/sample-export.json, timestamps shifted to
// now) comes back, in one `wrangler d1 execute` against the running dev server's database. Tokens
// stay, so the token minted in global setup keeps working.
//
// That's a second process on the same SQLite file, and the server may still be serving the last
// test's long-poll of /api/changes (it reads D1 until its wait runs out, after the page has gone).
// A read at the wrong moment makes the write fail with SQLITE_BUSY instead of waiting, so the reset
// tries again; the DELETE first makes a retry land on the same data. Web Push devices a test stored go too.
export async function resetData(): Promise<void> {
  const { sql } = buildImportSql(normalizeExport(seedExport(Date.now())), { replace: true, withLease: true });
  const reviews = "DELETE FROM review_events;\nDELETE FROM review_prs;\nDELETE FROM review_runs;\nDELETE FROM review_routines;\n";
  await executeSql("reset.sql", "DELETE FROM snoozes;\nDELETE FROM pins;\nDELETE FROM docs;\nDELETE FROM push_subscriptions;\n" + reviews + sql, "resetting the D1 data");
}

// Adds `count` archived decisions on top of the seed, newest first: item i is `archived-<i>` (zero-padded to 3),
// titled "Archived decision <i>" unless `titles` names it, updated a day and i+1 hours ago (older than the seed's
// own activity, an hour apart, so their order is item order).
export async function seedArchived(count: number, titles: Record<number, string> = {}): Promise<{ id: (i: number) => string }> {
  const id = (i: number) => "archived-" + String(i).padStart(3, "0");
  const base = Date.now() - 24 * 3600_000;
  const items = Array.from({ length: count }, (_, i) => {
    const at = new Date(base - (i + 1) * 3600_000).toISOString();
    return {
      id: id(i),
      data: {
        type: "decision", status: "archived", title: titles[i] ?? "Archived decision " + i, created_at: at, updated_at: at,
        options: [{ id: "yes", label: "Yes" }], decision: { choice: "yes", decided_at: at, by: "human:dev@localhost" },
      },
    };
  });
  const { sql } = buildImportSql(normalizeExport({ items }), {});
  await executeSql("archived.sql", sql, "seeding archived items");
  return { id };
}

// Runs SQL against the running dev server's D1 through `wrangler d1 execute`, retrying SQLITE_BUSY (see resetData),
// so it must be safe to repeat.
export async function executeSql(name: string, sql: string, what: string): Promise<void> {
  const file = resolve(PERSIST_TO, name);
  writeFileSync(file, sql);
  for (let attempt = 1; ; attempt++) {
    try {
      run(WRANGLER, ["d1", "execute", "agent-inbox", "--local", "--persist-to", PERSIST_TO, "--config", WRANGLER_CONFIG, "--file", file, "--yes"], what);
      return;
    } catch (e) {
      if (attempt >= 10 || !/SQLITE_BUSY|database is locked/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

// Set by global setup; Playwright starts the test workers after it, so they inherit them.
export function serverEnv(): { baseURL: string; token: string } {
  const baseURL = process.env.E2E_BASE_URL, token = process.env.E2E_TOKEN;
  if (!baseURL || !token) throw new Error("e2e: E2E_BASE_URL / E2E_TOKEN unset; run the suite with `npm run e2e`");
  return { baseURL, token };
}
