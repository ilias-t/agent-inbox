// Bearer tokens: ait_<id>_<secret> (docs/api.md "Tokens"). The id is 12
// lowercase base32 chars, the secret 32 random bytes as base64url, and D1
// stores only the SHA-256 hex of the secret string.

import { createHash, randomBytes } from "node:crypto";
import { isValidId } from "./ids.mjs";
import { sqlValue } from "./sql.mjs";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const TOKEN_RE = /^ait_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/;

export function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// 32 divides 256, so `byte % 32` has no modulo bias.
export function mintToken(random = randomBytes) {
  const id = [...random(12)].map((b) => BASE32[b % 32]).join("");
  const secret = Buffer.from(random(32)).toString("base64url");
  return { id, secret, token: `ait_${id}_${secret}`, secret_hash: sha256Hex(secret) };
}

export function validateTokenArgs({ name, scope, orchestrator }) {
  if (!name || typeof name !== "string") return "--name is required";
  if (name.length > 64) return "--name is at most 64 characters";
  if (scope !== "manager" && scope !== "orchestrator") return "--scope must be manager or orchestrator";
  if (scope === "orchestrator" && !orchestrator) return "--orchestrator is required for --scope orchestrator";
  if (scope === "manager" && orchestrator) return "--orchestrator only applies to --scope orchestrator";
  if (orchestrator && !isValidId(orchestrator)) return `invalid orchestrator id: ${orchestrator}`;
  return null;
}

// The INSERT for a minted token, then a count saying whether it landed. Holds
// the hash only, never the secret. Like POST /api/tokens, it inserts nothing
// when a live (unrevoked) token already has the name: the change log tells
// tokens apart by name. One line, for `wrangler d1 execute --command`.
export function tokenInsertSql({ id, secret_hash }, { name, scope, orchestrator }, now = new Date().toISOString()) {
  const values = [id, name, scope, orchestrator ?? null, secret_hash, now, "script"].map(sqlValue);
  return (
    `INSERT INTO tokens (id, name, scope, orchestrator, secret_hash, created_at, created_by) ` +
    `SELECT ${values.join(", ")} ` +
    `WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE name = ${sqlValue(name)} AND revoked_at IS NULL); ` +
    `SELECT count(*) AS inserted FROM tokens WHERE id = ${sqlValue(id)};`
  );
}

// Whether tokenInsertSql inserted, from `wrangler d1 execute --json` output
// (one result per statement; the count is the last). Throws when it can't tell.
export function tokenInserted(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`can't read wrangler's --json output: ${String(stdout).slice(0, 200)}`);
  }
  const n = Array.isArray(parsed) ? parsed.at(-1)?.results?.[0]?.inserted : undefined;
  if (n !== 0 && n !== 1) throw new Error(`unexpected wrangler --json output: ${String(stdout).slice(0, 200)}`);
  return n === 1;
}
