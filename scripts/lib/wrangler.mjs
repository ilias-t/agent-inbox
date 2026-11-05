// Runs a SQL file against the agent-inbox D1 database with wrangler.
// Local by default; the remote database needs an explicit --remote.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DATABASE = "agent-inbox";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Shared target flags: --local (default), --remote, --persist-to <dir>, and
// --config <file> (wrangler's --config: which instance's wrangler config names
// the database; default wrangler.jsonc).
export const TARGET_OPTIONS = {
  local: { type: "boolean" },
  remote: { type: "boolean" },
  "persist-to": { type: "string" },
  config: { type: "string" },
};

export function targetFrom(values) {
  if (values.local && values.remote) throw new Error("pass --local or --remote, not both");
  if (values.remote && values["persist-to"]) throw new Error("--persist-to only applies to --local");
  return { remote: !!values.remote, persistTo: values["persist-to"], config: values.config };
}

export function describeTarget({ remote, persistTo, config }) {
  const via = config ? ` via ${config}` : "";
  if (remote) return `REMOTE D1 database ${DATABASE}${via}`;
  return `local D1 database ${DATABASE}${via}${persistTo ? ` (persisted in ${persistTo})` : " (.wrangler state)"}`;
}

// The wrangler flags shared by every d1 command here.
function targetArgs({ remote, persistTo, config }) {
  const args = [remote ? "--remote" : "--local"];
  if (persistTo) args.push("--persist-to", resolve(persistTo));
  if (config) args.push("--config", resolve(config));
  return args;
}

// Runs a short SQL command with `--json` and returns {status, stdout}: one
// result per statement, local and remote alike (a remote `--file` goes
// through D1's import, which doesn't return statement results).
export function querySql(sql, target) {
  const args = ["wrangler", "d1", "execute", DATABASE, ...targetArgs(target), "--command", sql, "--json", "--yes"];
  const r = spawnSync("npx", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", process.stderr], encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout };
}

// Writes sql to a temp file, runs `wrangler d1 execute`, removes the file.
// Returns wrangler's exit status; its output goes to stderr.
export function executeSql(sql, target) {
  const dir = mkdtempSync(join(tmpdir(), "agent-inbox-sql-"));
  const file = join(dir, "run.sql");
  try {
    writeFileSync(file, sql, { mode: 0o600 });
    const args = ["wrangler", "d1", "execute", DATABASE, ...targetArgs(target), "--file", file, "--yes"];
    const r = spawnSync("npx", args, { cwd: REPO_ROOT, stdio: ["ignore", process.stderr, process.stderr] });
    if (r.error) throw r.error;
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
