// Bearer tokens: ait_<id>_<secret> (docs/api.md "Tokens"). The id is 12
// lowercase base32 chars, the secret 32 random bytes as base64url, and D1
// stores only the SHA-256 hex of the secret string.

import { createHash, randomBytes } from "node:crypto";
import { mintFleetDocSql, mintOutcomeSql, mintRefusal, mintTokenSql } from "../../shared/mint-sql.mjs";
import { isValidId } from "./ids.mjs";
import { sqlValue } from "./sql.mjs";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const TOKEN_RE = /^ait_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/;
// A named fleet's id, as shared/types.ts FLEET_ID_RE; "default" names the default fleet.
export const FLEET_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// 32 divides 256, so `byte % 32` has no modulo bias.
export function mintToken(random = randomBytes) {
  const id = [...random(12)].map((b) => BASE32[b % 32]).join("");
  const secret = Buffer.from(random(32)).toString("base64url");
  return { id, secret, token: `ait_${id}_${secret}`, secret_hash: sha256Hex(secret) };
}

export function validateTokenArgs({ name, scope, orchestrator, fleet, createFleet }) {
  if (!name || typeof name !== "string") return "--name is required";
  if (name.length > 64) return "--name is at most 64 characters";
  if (scope !== "manager" && scope !== "orchestrator") return "--scope must be manager or orchestrator";
  if (scope === "orchestrator" && !orchestrator) return "--orchestrator is required for --scope orchestrator";
  if (scope === "manager" && orchestrator) return "--orchestrator only applies to --scope orchestrator";
  if (orchestrator && !isValidId(orchestrator)) return `invalid orchestrator id: ${orchestrator}`;
  if (fleet !== undefined && !FLEET_ID_RE.test(fleet)) {
    return `--fleet must be default or a fleet id (a lowercase letter, then up to 31 lowercase letters, numbers or -): ${fleet}`;
  }
  if (createFleet && (fleet === undefined || fleet === "default")) return "--create-fleet needs a named --fleet";
  return null;
}

// The statements for a minted token (shared/mint-sql.mjs: the very rules POST /api/tokens applies), then a row
// saying whether it landed and, if not, why. Holds the hash only, never the secret. `fleet` left out: a manager
// token takes the fleet that owns its id (else the default fleet), an orchestrator token the default fleet. With
// `createFleet`, an unregistered fleet is registered too, only once the token is stored. One line, for
// `wrangler d1 execute --command`.
export function tokenInsertSql({ id, secret_hash }, { name, scope, orchestrator, fleet, createFleet }, now = new Date().toISOString()) {
  const v = {
    id: sqlValue(id),
    name: sqlValue(name),
    scope: sqlValue(scope),
    orchestrator: sqlValue(orchestrator ?? null),
    hash: sqlValue(secret_hash),
    now: sqlValue(now),
    by: sqlValue("script"),
    fleet: sqlValue(fleet ?? null),
  };
  const statements = [mintTokenSql(v, { createFleet: !!createFleet }), ...(createFleet ? [mintFleetDocSql(v)] : []), mintOutcomeSql(v)];
  return statements.join("; ") + ";";
}

// What tokenInsertSql did, from `wrangler d1 execute --json` output (one result per statement; the outcome row is
// the last): {inserted, fleet} plus, when refused, `refusal` ({status, message}, as the API would answer). Throws
// when it can't tell.
export function tokenOutcome(stdout, { name, orchestrator }) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`can't read wrangler's --json output: ${String(stdout).slice(0, 200)}`);
  }
  const row = Array.isArray(parsed) ? parsed.at(-1)?.results?.[0] : undefined;
  const n = row?.inserted;
  if (n !== 0 && n !== 1) throw new Error(`unexpected wrangler --json output: ${String(stdout).slice(0, 200)}`);
  if (n === 1) return { inserted: true, fleet: row.fleet };
  return { inserted: false, fleet: row.fleet, refusal: mintRefusal(row, { name, orchestrator }) };
}
