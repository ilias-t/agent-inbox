#!/usr/bin/env node
// Mints a bearer token and inserts its hash into D1 (bootstrap without the UI).
// Usage: node scripts/create-token.mjs --name <name> --scope manager|orchestrator
//        [--orchestrator O3] [--local|--remote] [--persist-to DIR] [--config FILE] [--dry-run]
// The token is printed once on stdout; only its SHA-256 is stored. Like the
// API, it refuses (exit 1, nothing stored) a name a live token already has.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { mintToken, tokenInsertSql, tokenInserted, validateTokenArgs } from "./lib/token.mjs";
import { TARGET_OPTIONS, describeTarget, querySql, targetFrom } from "./lib/wrangler.mjs";

const USAGE =
  "Usage: node scripts/create-token.mjs --name <name> --scope manager|orchestrator [--orchestrator O3] [--local|--remote] [--persist-to DIR] [--config FILE] [--dry-run]";

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...TARGET_OPTIONS,
      name: { type: "string" },
      scope: { type: "string" },
      orchestrator: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const args = { name: values.name, scope: values.scope, orchestrator: values.orchestrator };
  const problem = validateTokenArgs(args);
  if (problem) {
    console.error(`create-token: ${problem}\n${USAGE}`);
    return 2;
  }
  const target = targetFrom(values);
  const minted = mintToken();
  const sql = tokenInsertSql(minted, args);
  const who = args.scope === "orchestrator" ? `orchestrator ${args.orchestrator}` : "manager";
  if (values["dry-run"]) {
    console.error(`dry run: would insert token ${minted.id} (${args.name}, ${who}) into ${describeTarget(target)}:`);
    console.error(sql.trim());
    return 0;
  }
  console.error(`inserting token ${minted.id} (${args.name}, ${who}) into ${describeTarget(target)} ...`);
  const { status, stdout } = querySql(sql, target);
  if (status !== 0) {
    console.error("create-token: wrangler failed; no token was created");
    return 1;
  }
  if (!tokenInserted(stdout)) {
    console.error(`create-token: a live token is already named "${args.name}"; no token was created. Pick another name, or revoke that token first.`);
    return 1;
  }
  console.error("Token (shown once; put it in AGENT_INBOX_TOKEN or ~/.config/agent-inbox/config.json):");
  console.log(minted.token);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`create-token: ${err.message}`);
    process.exitCode = 2;
  }
}
