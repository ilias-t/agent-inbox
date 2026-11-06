import { env, exports } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setAccessKeysForTest } from "../../worker/auth.ts";
import { agent, call, human, mintToken } from "./helpers.ts";

const HOST = "inbox.test"; // not localhost: DEV_NO_ACCESS must not apply
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  setAccessKeysForTest(createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "k1" }] }));
});
afterAll(() => setAccessKeysForTest(null));

function jwt(claims: { aud?: string; iss?: string; email?: string; exp?: string } = {}) {
  return new SignJWT({ email: claims.email ?? "you@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? `https://${env.ACCESS_TEAM_DOMAIN}`)
    .setAudience(claims.aud ?? env.ACCESS_AUD!)
    .setExpirationTime(claims.exp ?? "5m")
    .sign(privateKey);
}

const withJwt = async (token: string, path = "/api/me") =>
  call("GET", path, { host: HOST, headers: { "cf-access-jwt-assertion": token } });

describe("auth", () => {
  it("no credentials → 401 (no-store), even for unknown routes", async () => {
    const r = await call("GET", "/api/me", { host: HOST });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthorized");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await call("GET", "/api/nope", { host: HOST })).status).toBe(401);
  });

  it("DEV_NO_ACCESS only applies on localhost / 127.0.0.1", async () => {
    expect((await call("GET", "/api/me")).body).toEqual({ kind: "human", email: "you@test", role: "admin", is_admin: true });
    expect((await call("GET", "/api/me", { host: "127.0.0.1:8787" })).status).toBe(200);
    expect((await call("GET", "/api/me", { host: "localhost.evil.test" })).status).toBe(401);
  });

  it("accepts a valid Access JWT", async () => {
    const r = await withJwt(await jwt());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ kind: "human", email: "you@example.com", role: "admin", is_admin: true });
  });

  it("rejects a wrong audience, wrong issuer, expired token or garbage", async () => {
    expect((await withJwt(await jwt({ aud: "other-app" }))).status).toBe(401);
    expect((await withJwt(await jwt({ iss: "https://evil.cloudflareaccess.com" }))).status).toBe(401);
    expect((await withJwt(await jwt({ exp: "-1m" }))).status).toBe(401);
    expect((await withJwt("not.a.jwt")).status).toBe(401);
  });

  it("/agent/api requires a bearer token, even with a JWT or on localhost", async () => {
    expect((await call("GET", "/agent/api/me")).status).toBe(401);
    const r = await call("GET", "/agent/api/me", { host: HOST, headers: { "cf-access-jwt-assertion": await jwt() } });
    expect(r.status).toBe(401);
  });

  it("bearer tokens work on both prefixes; malformed or unknown ones are 401", async () => {
    const { secret, token } = await mintToken("manager", undefined, "mgr");
    expect(secret).toMatch(/^ait_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    expect((await agent(secret).get("/api/me")).body).toEqual({ kind: "token", name: "mgr", scope: "manager", fleet: "default" });
    expect((await call("GET", "/api/me", { host: HOST, token: secret })).status).toBe(200);
    expect((await call("GET", "/api/me", { host: HOST, token: secret.slice(0, -2) + "xx" })).status).toBe(401);
    expect((await call("GET", "/api/me", { host: HOST, token: "nope" })).status).toBe(401);
    expect((await call("GET", "/api/me", { host: HOST, headers: { Authorization: "Basic abc" } })).status).toBe(401);
    // A bad bearer never falls back to the localhost dev user.
    expect((await call("GET", "/api/me", { token: "ait_bad" })).status).toBe(401);
    // last_used_at is written in waitUntil, after the response.
    await vi.waitFor(async () => {
      const row = await env.DB.prepare("SELECT last_used_at FROM tokens WHERE id = ?").bind(token.id).first();
      expect(row?.last_used_at).toEqual(expect.any(String));
    });
  });

  it("CSRF: cookie/dev writes must be JSON and same-origin; bearer callers are exempt", async () => {
    const tick = "/api/meta/manager/tick-request";
    const form = await call("POST", tick, { body: "note=x", headers: { "Content-Type": "text/plain" } });
    expect(form.status).toBe(415);
    expect(form.body.error).toBe("bad_request");
    const formUrlEnc = await call("POST", tick, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(formUrlEnc.status).toBe(415);
    // No Content-Type at all (a bodiless fetch or form).
    const bare = await exports.default.fetch("http://localhost/api/items/x", { method: "DELETE" });
    expect(bare.status).toBe(415);
    const cross = await call("POST", tick, { headers: { Origin: "https://evil.test" } });
    expect(cross.status).toBe(403);
    expect((await call("POST", tick, { headers: { Origin: "http://localhost" } })).status).toBe(200);
    expect((await call("POST", tick, { headers: { "Content-Type": "application/json; charset=utf-8" } })).status).toBe(200);
    // Reads are unaffected.
    expect((await call("GET", "/api/me", { headers: { Origin: "https://evil.test" } })).status).toBe(200);
    // JWT callers too.
    const viaJwt = await call("POST", tick, {
      host: HOST,
      headers: { "cf-access-jwt-assertion": await jwt(), "Content-Type": "text/plain" },
    });
    expect(viaJwt.status).toBe(415);

    const { secret } = await mintToken("manager", undefined, "csrf-mgr");
    const bearer = await call("POST", tick, {
      host: HOST,
      token: secret,
      headers: { "Content-Type": "text/plain", Origin: "https://elsewhere.test" },
    });
    expect(bearer.status).toBe(200);
  });

  it("/agent/* outside /agent/api is a JSON 404, never the SPA", async () => {
    for (const path of ["/agent", "/agent/", "/agent/index.html", "/agent/items"]) {
      const r = await call("GET", path, { host: HOST });
      expect(r.status, path).toBe(404);
      expect(r.body.error).toBe("not_found");
      expect(r.headers.get("content-type")).toBe("application/json");
    }
  });

  it("unknown routes are 404 once authenticated", async () => {
    expect((await human.get("/api/nope")).status).toBe(404);
    expect((await call("POST", "/api/me")).status).toBe(404);
  });
});

describe("tokens", () => {
  it("are human-only, show the secret once, and revoke", async () => {
    const created = await human.post("/api/tokens", { name: "o3", scope: "orchestrator", orchestrator: "O3" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatchObject({ name: "o3", scope: "orchestrator", orchestrator: "O3", revoked_at: null });
    expect(created.body.token.secret_hash).toBeUndefined();
    const list = await human.get("/api/tokens");
    const info = list.body.tokens.find((t: any) => t.id === created.body.token.id);
    expect(info).toBeDefined();
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret.split("_").slice(2).join("_"));

    const mgr = agent((await mintToken("manager")).secret);
    expect((await mgr.get("/api/tokens")).status).toBe(403);
    expect((await mgr.post("/api/tokens", { name: "x", scope: "manager" })).status).toBe(403);

    const o3 = agent(created.body.secret);
    expect((await o3.get("/api/me")).status).toBe(200);
    expect((await human.del(`/api/tokens/${created.body.token.id}`)).body).toEqual({ ok: true });
    expect((await o3.get("/api/me")).status).toBe(401);
    expect((await human.del("/api/tokens/aaaaaaaaaaaa")).status).toBe(404);
  });

  it("refuses a name a live token already has (409 conflict), and stores nothing", async () => {
    const first = await human.post("/api/tokens", { name: "dup-name", scope: "manager" });
    expect(first.status).toBe(201);
    const again = await human.post("/api/tokens", { name: "dup-name", scope: "orchestrator", orchestrator: "O4" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conflict");
    expect(again.body.message).toMatch(/dup-name/);
    expect(again.body.secret).toBeUndefined();
    const named = (await human.get("/api/tokens")).body.tokens.filter((t: any) => t.name === "dup-name");
    expect(named).toHaveLength(1);
  });

  it("frees a name once its token is revoked, and doesn't fold case", async () => {
    const first = await human.post("/api/tokens", { name: "reuse-me", scope: "manager" });
    expect((await human.post("/api/tokens", { name: "Reuse-Me", scope: "manager" })).status).toBe(201);
    await human.del(`/api/tokens/${first.body.token.id}`);
    const second = await human.post("/api/tokens", { name: "reuse-me", scope: "manager" });
    expect(second.status).toBe(201);
    expect(second.body.token.id).not.toBe(first.body.token.id);
  });

  it("validates create input", async () => {
    expect((await human.post("/api/tokens", { name: "", scope: "manager" })).status).toBe(400);
    expect((await human.post("/api/tokens", { name: "x", scope: "admin" })).status).toBe(400);
    expect((await human.post("/api/tokens", { name: "x", scope: "orchestrator" })).status).toBe(400);
  });
});
