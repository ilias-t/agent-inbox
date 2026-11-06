// Bearer tokens (admin humans only). The secret is shown once; D1 keeps its SHA-256.
// A live (unrevoked) token's name is unique: the change log records writers as
// `token:<name>`, so two live tokens sharing a name couldn't be told apart.
// Each token belongs to a fleet (docs/api.md "Fleets"): the one asked for, or for a
// manager token the fleet that owns its manager id. shared/mint-sql.mjs holds the
// rules, as one statement the token script runs too.

import { mintOutcomeSql, mintRefusal, mintTokenSql, type MintOutcome } from "../../shared/mint-sql.mjs";
import { DEFAULT_FLEET, type TokenInfo } from "../../shared/types.ts";
import { requireAdmin } from "../auth.ts";
import { parseFleet } from "../fleets.ts";
import { badRequest, checkId, HttpError, json, notFound, optString, reqString, sha256Hex } from "../http.ts";
import type { Ctx, Route } from "../router.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
// `fleet` as the API spells it: "default" for the default fleet (stored NULL).
const INFO_COLS = "id, name, scope, orchestrator, coalesce(fleet, 'default') AS fleet, created_at, created_by, last_used_at, revoked_at";
// mintTokenSql's values, as this route binds them.
const BOUND = { id: "?1", name: "?2", scope: "?3", orchestrator: "?4", hash: "?5", now: "?6", by: "?7", fleet: "?8" };

function tokenId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => BASE32[b & 31]).join("");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function list(c: Ctx): Promise<Response> {
  requireAdmin(c.caller);
  const { results } = await c.env.DB.prepare(`SELECT ${INFO_COLS} FROM tokens ORDER BY created_at, id`).all<TokenInfo>();
  return json({ tokens: results });
}

async function create(c: Ctx): Promise<Response> {
  requireAdmin(c.caller);
  const body = await c.body();
  const name = reqString(body, "name", 100);
  const scope = body.scope;
  if (scope !== "manager" && scope !== "orchestrator") throw badRequest("scope must be manager or orchestrator");
  const orch = optString(body, "orchestrator", 128);
  if (scope === "orchestrator" && !orch) throw badRequest("orchestrator is required for scope orchestrator");
  const orchestrator = scope === "orchestrator" ? checkId(orch!) : null;
  // null: take the owner's (a manager token), else the default fleet. "default" is asked for, so it must match.
  const fleet = body.fleet === undefined || body.fleet === null ? null : (parseFleet(body.fleet) ?? DEFAULT_FLEET);

  const id = tokenId();
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  // Every check and the insert are one statement, so concurrent creates can't
  // both pass one. Names compare exactly, as actors do.
  const binds = [id, name, scope, orchestrator, await sha256Hex(secret), c.now, c.caller.actor, fleet];
  const info = await c.env.DB.prepare(`${mintTokenSql(BOUND)} RETURNING ${INFO_COLS}`)
    .bind(...binds)
    .first<TokenInfo>();
  if (!info) {
    const why = await c.env.DB.prepare(mintOutcomeSql(BOUND)).bind(...binds).first<MintOutcome>();
    const { status, message } = mintRefusal(why!, { name, orchestrator });
    throw status === 400 ? badRequest(message) : new HttpError(409, "conflict", message);
  }
  return json({ token: info, secret: `ait_${id}_${secret}` }, 201);
}

async function revoke(c: Ctx): Promise<Response> {
  requireAdmin(c.caller);
  const r = await c.env.DB.prepare("UPDATE tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?")
    .bind(c.now, c.params.id)
    .run();
  if (!r.meta.changes) throw notFound(`No token ${c.params.id}`);
  return json({ ok: true });
}

export const tokenRoutes: Route[] = [
  ["GET", "/tokens", list],
  ["POST", "/tokens", create],
  ["DELETE", "/tokens/:id", revoke],
];
