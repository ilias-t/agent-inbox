// Reads the repo's wrangler configs (JSONC: comments and trailing commas) and
// knows which of their values belong to one deployment (an "instance") rather
// than to the app. wrangler.example.jsonc is the shape every config shares;
// wrangler.test.jsonc fills the instance values with fakes for the tests.

import { readFileSync } from "node:fs";
import { parse, printParseErrorCode } from "jsonc-parser";

// Parses a JSONC file with jsonc-parser and the options wrangler itself reads
// its config with (comments and trailing commas allowed, a leading BOM
// dropped). jsonc-parser recovers from errors and returns what it could read,
// so any error throws here instead, naming the first one's line and column.
export function readJsonc(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const { error, offset } = errors[0];
    const lines = text.slice(0, offset).split("\n");
    throw new Error(`${path}:${lines.length}:${lines.at(-1).length + 1}: ${printParseErrorCode(error)}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${path}: the top level must be an object`);
  return config;
}

// The values that differ between instances, as [path, description] pairs.
export const INSTANCE_FIELDS = [
  ["name", "Worker name"],
  ["d1_databases.0.database_id", "D1 database id"],
  ["vars.ACCESS_TEAM_DOMAIN", "Access team domain"],
  ["vars.ACCESS_AUD", "Access application AUD tag"],
  ["vars.PUBLIC_URL", "public base URL"],
];

const INSTANCE_VARS = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "PUBLIC_URL"];

// One instance's config: the example with the instance values filled in, plus
// optional extra vars (e.g. CHANGES_RETENTION_DAYS). Throws, naming every
// problem, when a value is missing or malformed, so a deploy never goes out
// with a placeholder or an empty binding.
// values: { name?, databaseId, accessTeamDomain, accessAud, publicUrl, vars? }
export function instanceConfig(example, values) {
  const name = values.name || "agent-inbox";
  const problems = [];
  const need = (v, what) => {
    if (typeof v !== "string" || !v.trim()) problems.push(`${what} is empty`);
    else if (/[<>\s]/.test(v)) problems.push(`${what} looks like a placeholder: ${JSON.stringify(v)}`);
  };
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) problems.push(`Worker name ${JSON.stringify(name)} must be lowercase letters, digits and dashes`);
  need(values.databaseId, "D1 database id");
  need(values.accessTeamDomain, "Access team domain");
  need(values.accessAud, "Access AUD tag");
  need(values.publicUrl, "public URL");
  const filled = (v) => typeof v === "string" && v.trim() && !/[<>\s]/.test(v);
  // Shapes, so a typo fails here rather than as a Worker that deploys, passes the smoke test and
  // then rejects every browser sign-in.
  if (filled(values.databaseId) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.databaseId.trim()))
    problems.push(`D1 database id must be a UUID: ${JSON.stringify(values.databaseId)}`);
  if (filled(values.accessTeamDomain) && !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(values.accessTeamDomain.trim()))
    problems.push(`Access team domain must be <team>.cloudflareaccess.com: ${JSON.stringify(values.accessTeamDomain)}`);
  if (filled(values.accessAud) && !/^[0-9a-f]{64}$/.test(values.accessAud.trim()))
    problems.push(`Access AUD tag must be 64 hex characters: ${JSON.stringify(values.accessAud)}`);
  const publicUrl = String(values.publicUrl ?? "").trim().replace(/\/+$/, "");
  if (filled(values.publicUrl) && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(publicUrl))
    problems.push(`public URL must be https://<host> with no path, query or fragment: ${JSON.stringify(values.publicUrl)}`);
  const extra = values.vars ?? {};
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) problems.push("extra vars must be a JSON object");
  else {
    for (const [k, v] of Object.entries(extra)) {
      if (INSTANCE_VARS.includes(k)) problems.push(`extra vars can't set ${k}; it has its own value`);
      else if (typeof v !== "string") problems.push(`extra var ${k} must be a string`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));

  const config = structuredClone(example);
  config.name = name;
  if (config.d1_databases?.length !== 1) throw new Error("the example config must have exactly one D1 database");
  config.d1_databases[0].database_id = values.databaseId.trim();
  config.vars = {
    ...config.vars,
    ...extra,
    ACCESS_TEAM_DOMAIN: values.accessTeamDomain.trim(),
    ACCESS_AUD: values.accessAud.trim(),
    PUBLIC_URL: publicUrl,
  };
  return config;
}

// A deep copy of config with every instance field removed.
export function withoutInstanceValues(config) {
  const copy = structuredClone(config);
  for (const [path] of INSTANCE_FIELDS) {
    const keys = path.split(".");
    const last = keys.pop();
    const parent = keys.reduce((o, k) => o?.[k], copy);
    if (parent && typeof parent === "object") delete parent[last];
  }
  return copy;
}
