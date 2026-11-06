// Who is calling. Every /api request is authenticated here, so the API fails
// closed even if Cloudflare Access is missing in front of the Worker:
// a bearer token (agents, and humans' scripts), else Access's signed JWT
// (browsers), else DEV_NO_ACCESS on localhost only.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { DEFAULT_FLEET, FLEET_ID_RE, type Principal, type Role } from "../shared/types.ts";
import type { Env } from "./env.ts";
import { forbidden, HttpError, safeEqual, sha256Hex, unauthorized } from "./http.ts";
import { atLeast, resolveRole } from "./users.ts";

export interface Caller {
  principal: Principal;
  actor: string; // "human:<email>" | "token:<name>"
  // False for Access/dev callers, whose browser attaches credentials to
  // cross-site requests too; those get the CSRF checks in index.ts.
  bearer: boolean;
  // Tokens only: the fleet the token is bound to, null for the default fleet (docs/api.md "Fleets"). Humans
  // have none: they see every fleet.
  fleet?: string | null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// One key set per team domain for the isolate's life; jose caches the keys
// and refetches when Access rotates them.
const keySets = new Map<string, JWTVerifyGetKey>();
let keyOverride: JWTVerifyGetKey | null = null;

// Tests only: verify Access JWTs against a local key instead of the team's JWKS.
export function setAccessKeysForTest(keys: JWTVerifyGetKey | null): void {
  keyOverride = keys;
}

function accessKeys(teamDomain: string): JWTVerifyGetKey {
  if (keyOverride) return keyOverride;
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

async function accessEmail(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  try {
    const { payload } = await jwtVerify(token, accessKeys(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    return typeof payload.email === "string" && payload.email ? payload.email : null;
  } catch {
    return null;
  }
}

// ait_<12 base32>_<base64url secret>. The secret may itself contain "_".
const TOKEN_RE = /^ait_([a-z2-7]{12})_([A-Za-z0-9_-]{20,128})$/;

interface TokenRow {
  id: string;
  name: string;
  scope: "manager" | "orchestrator";
  orchestrator: string | null;
  fleet: string | null;
  secret_hash: string;
  last_used_at: string | null;
}

async function bearerCaller(raw: string, env: Env, ctx: ExecutionContext): Promise<Caller> {
  const m = TOKEN_RE.exec(raw);
  if (!m) throw unauthorized("Malformed token");
  const row = await env.DB.prepare(
    "SELECT id, name, scope, orchestrator, fleet, secret_hash, last_used_at FROM tokens WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(m[1])
    .first<TokenRow>();
  // Hash even when the row is missing so timing doesn't reveal valid ids.
  const hash = await sha256Hex(m[2]);
  if (!row || !safeEqual(hash, row.secret_hash)) throw unauthorized("Invalid or revoked token");

  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
        .bind(new Date(now).toISOString(), row.id)
        .run()
        .catch((e) => console.error("last_used_at", e)),
    );
  }
  // NULL (or "default") is the default fleet. Any other value must be a fleet id: a hand-edited row that holds
  // something else is refused, rather than scoped to a fleet no doc can name.
  const fleet = row.fleet === DEFAULT_FLEET ? null : row.fleet;
  if (fleet !== null && !FLEET_ID_RE.test(fleet)) throw unauthorized("Token has an invalid fleet");
  const principal: Principal =
    row.scope === "orchestrator"
      ? { kind: "token", name: row.name, scope: "orchestrator", orchestrator: row.orchestrator ?? "", fleet: fleet ?? DEFAULT_FLEET }
      : { kind: "token", name: row.name, scope: "manager", fleet: fleet ?? DEFAULT_FLEET };
  return { principal, actor: `token:${row.name}`, bearer: true, fleet };
}

// The human's role from the users table (worker/users.ts says how it resolves).
async function humanCaller(env: Env, email: string): Promise<Caller> {
  const role = await resolveRole(env, email);
  return { principal: { kind: "human", email, role, is_admin: role === "admin" }, actor: `human:${email}`, bearer: false };
}

export async function authenticate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  opts: { bearerOnly: boolean },
): Promise<Caller> {
  const header = request.headers.get("authorization");
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) throw unauthorized("Malformed Authorization header");
    return bearerCaller(m[1], env, ctx);
  }
  if (opts.bearerOnly) throw unauthorized("Bearer token required");

  const email = await accessEmail(request, env);
  if (email) return humanCaller(env, email);

  if (env.DEV_NO_ACCESS === "1" && LOCAL_HOSTS.has(new URL(request.url).hostname)) {
    return humanCaller(env, env.DEV_USER_EMAIL || "dev@localhost");
  }
  throw unauthorized();
}

// --- Scope helpers -----------------------------------------------------------

export const isHuman = (c: Caller) => c.principal.kind === "human";

// Cookie-authenticated writes must be JSON (a cross-site <form> can't send
// application/json without a CORS preflight) and same-origin when the
// browser says where they came from.
export function checkCsrf(c: Caller, request: Request, url: URL): void {
  if (c.bearer || request.method === "GET" || request.method === "HEAD") return;
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, "bad_request", "Content-Type must be application/json");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) throw forbidden("Cross-origin request");
}

// The orchestrator id an orchestrator token is limited to, or null for full access.
export function orchestratorScope(c: Caller): string | null {
  const p = c.principal;
  return p.kind === "token" && p.scope === "orchestrator" ? p.orchestrator : null;
}

// --- Fleets (docs/api.md "Fleets") ---------------------------------------------

// The fleet a token is bound to (null: the default fleet), or undefined for a human, who sees every fleet.
export function fleetScope(c: Caller): string | null | undefined {
  return c.principal.kind === "token" ? (c.fleet ?? null) : undefined;
}

// A doc's fleet as stored: data.fleet (an own property), null when absent (the default fleet). Any other
// value is kept as it is, so it matches no token's fleet, as in SQL (`fleet IS ?`).
export function docFleet(data: object | null | undefined): unknown {
  return data && Object.hasOwn(data, "fleet") ? (data as Record<string, unknown>).fleet : null;
}

// 403 when a token reads or writes a doc of another fleet. Humans pass.
export function requireFleet(c: Caller, data: object | null | undefined, what = "Item"): void {
  const f = fleetScope(c);
  if (f !== undefined && docFleet(data) !== f) throw forbidden(`${what} belongs to another fleet`);
}

// The SQL condition limiting a fleet column (`col`, as stored) to the caller's fleet, with its bind: none for
// a human. `fleet IS ?` with a null bind matches the default fleet.
export function fleetWhere(c: Caller, col = "fleet"): { sql: string; binds: unknown[] } {
  const f = fleetScope(c);
  return f === undefined ? { sql: "", binds: [] } : { sql: ` AND ${col} IS ?`, binds: [f] };
}

// Human or manager token.
export function requireFull(c: Caller): void {
  if (orchestratorScope(c) !== null) throw forbidden();
}

export function requireHuman(c: Caller): void {
  if (!isHuman(c)) throw forbidden("Humans only");
}

// A human needs at least `min`; tokens pass (their scope rules apply instead).
// Viewers only read; deciders also decide, ask, request ticks and reassign;
// admins do everything. Called inside op builders too, so /api/batch is held
// to the same rules as the routes.
export function requireRole(c: Caller, min: Role): void {
  const p = c.principal;
  if (p.kind !== "human" || atLeast(p.role, min)) return;
  throw forbidden(min === "admin" ? "Admins only" : `Needs the ${min} role; you are a ${p.role}`);
}

// A human of at least `min`, or the manager token.
export function requireFullRole(c: Caller, min: Role): void {
  requireFull(c);
  requireRole(c, min);
}

// Token and user management: an admin human.
export function requireAdmin(c: Caller): void {
  requireHuman(c);
  requireRole(c, "admin");
}

// Schedule writes: an admin human or the manager token.
export function requireFullAdmin(c: Caller): void {
  requireFullRole(c, "admin");
}
