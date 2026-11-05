#!/usr/bin/env node
// Copies the artifact inbox's collections into the agent-inbox D1 docs table.
// Usage: node scripts/import-artifact.mjs <export.json | export-dir> [--local|--remote]
//        [--persist-to DIR] [--config FILE] [--dry-run] [--replace] [--with-lease]
// See docs/deploy.md "Import from the artifact".

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildImportSql, normalizeExport, readExportDir } from "./lib/import.mjs";
import { TARGET_OPTIONS, describeTarget, executeSql, targetFrom } from "./lib/wrangler.mjs";

const USAGE = `Usage: node scripts/import-artifact.mjs <export.json | export-dir> [options]

  <export.json>   {items: [...], orchestrators: [...], meta: [...], "items/<id>/qa": [...]},
                  the same under {collections: {...}}, or [{collection, id, data, version}, ...]
  <export-dir>    an ArtifactData out_dir: <dir>/<collection>/<doc_id>.json

  --local         run against the local D1 state (default)
  --remote        run against the deployed D1 database
  --persist-to D  local state directory (wrangler --persist-to)
  --config F      wrangler config naming the database (default wrangler.jsonc)
  --dry-run       print the SQL and counts, run nothing
  --replace       overwrite existing docs (default: keep existing, insert the rest)
  --with-lease    also import meta/lease (skipped by default)`;

export function runImport(argv, { log = console.error, out = (s) => process.stdout.write(s) } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...TARGET_OPTIONS,
      "dry-run": { type: "boolean" },
      replace: { type: "boolean" },
      "with-lease": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    out(USAGE + "\n");
    return 0;
  }
  if (positionals.length !== 1) {
    log(USAGE);
    return 2;
  }
  const target = targetFrom(values);
  const path = positionals[0];
  const entries = statSync(path).isDirectory()
    ? readExportDir(path)
    : normalizeExport(JSON.parse(readFileSync(path, "utf8")));
  const result = buildImportSql(entries, { replace: !!values.replace, withLease: !!values["with-lease"] });

  for (const s of result.skipped) log(`skip ${s.collection ?? "?"}/${s.id ?? "?"}: ${s.reason}`);
  for (const d of result.derived) log(`derived ${d.collection}/${d.id} from ${d.from}`);
  const counts = Object.entries(result.counts).map(([c, n]) => `${c}=${n}`).join(" ") || "none";
  log(`${result.docs.length} docs (${counts}), ${result.skipped.length} skipped, mode ${values.replace ? "replace (upsert)" : "insert, keep existing"}`);

  if (values["dry-run"]) {
    out(result.sql);
    log(`dry run: nothing written (target would be ${describeTarget(target)})`);
    return 0;
  }
  if (result.docs.length === 0) {
    log("nothing to import");
    return 0;
  }
  log(`writing to ${describeTarget(target)} ...`);
  const status = executeSql(result.sql, target);
  if (status !== 0) log(`wrangler exited with ${status}`);
  return status === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = runImport(process.argv.slice(2));
  } catch (err) {
    console.error(`import-artifact: ${err.message}`);
    process.exitCode = err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? 2 : 1;
  }
}
