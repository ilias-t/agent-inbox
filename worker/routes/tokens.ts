// Bearer tokens (admin humans only). The secret is shown once; D1 keeps its SHA-256.
// A live (unrevoked) token's name is unique: the change log records writers as
// `token:<name>`, so two live tokens sharing a name couldn't be told apart.

import type { TokenInfo } from "../../shared/types.ts";
import { requireAdmin } from "../auth.ts";
import { badRequest, checkId, HttpError, json, notFound, optString, reqString, sha256Hex } from "../http.ts";
import type { Ctx, Route } from "../router.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const INFO_COLS = "id, name, scope, orchestrator, created_at, created_by, last_used_at, revoked_at";

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

  const id = tokenId();
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  // The name check and the insert are one statement, so two concurrent
  // creates can't both pass it. Names compare exactly, as actors do.
  const info = await c.env.DB.prepare(
    `INSERT INTO tokens (id, name, scope, orchestrator, secret_hash, created_at, created_by)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE name = ?2 AND revoked_at IS NULL)
     RETURNING ${INFO_COLS}`,
  )
    .bind(id, name, scope, orchestrator, await sha256Hex(secret), c.now, c.caller.actor)
    .first<TokenInfo>();
  if (!info) {
    throw new HttpError(409, "conflict", `A live token is already named "${name}". Pick another name, or revoke that token first.`);
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
