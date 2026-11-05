#!/usr/bin/env node
// Seeds sample data (scripts/fixtures/sample-export.json) through the importer.
// Usage: node scripts/seed.mjs [--local|--remote] [--persist-to DIR] [--config FILE] [--dry-run] [--static]
// Timestamps are shifted so the latest one is a minute ago (unless --static);
// only meta/manager.next_tick stays in the future. Re-running replaces the
// sample docs; other docs are untouched.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ISO_RE, buildImportSql, normalizeExport, shiftTimestamps } from "./lib/import.mjs";
import { REPO_ROOT, TARGET_OPTIONS, describeTarget, executeSql, targetFrom } from "./lib/wrangler.mjs";

export const FIXTURE = resolve(REPO_ROOT, "scripts/fixtures/sample-export.json");

// Latest fixture timestamp, ignoring next_tick (a planned time that should
// stay in the future).
function latestTimestamp(value, key) {
  if (typeof value === "string") return key !== "next_tick" && ISO_RE.test(value) ? Date.parse(value) : -Infinity;
  if (value && typeof value === "object") {
    return Math.max(-Infinity, ...Object.entries(value).map(([k, v]) => latestTimestamp(v, Array.isArray(value) ? key : k)));
  }
  return -Infinity;
}

// Shifts the fixture so its latest past event lands a minute before `now`;
// only meta/manager.next_tick ends up in the future.
export function seedExport(now = Date.now(), { shift = true } = {}) {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (!shift) return raw;
  return shiftTimestamps(raw, now - 60_000 - latestTimestamp(raw));
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { ...TARGET_OPTIONS, "dry-run": { type: "boolean" }, static: { type: "boolean" } },
  });
  const target = targetFrom(values);
  const result = buildImportSql(normalizeExport(seedExport(Date.now(), { shift: !values.static })), {
    replace: true,
    withLease: true,
  });
  const counts = Object.entries(result.counts).map(([c, n]) => `${c}=${n}`).join(" ");
  console.error(`seed: ${result.docs.length} docs (${counts})`);
  if (values["dry-run"]) {
    process.stdout.write(result.sql);
    return 0;
  }
  console.error(`writing to ${describeTarget(target)} ...`);
  return executeSql(result.sql, target) === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`seed: ${err.message}`);
    process.exitCode = 1;
  }
}
