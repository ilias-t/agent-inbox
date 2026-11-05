// Security headers on every response the Worker itself builds (/api, /agent/api, /hooks). The UI's
// HTML and static files get theirs from dist/_headers (shared/security-headers.ts), which the asset
// pipeline applies and Worker responses never see.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { API_HEADERS } from "../../shared/security-headers.ts";
import { call, human } from "./helpers.ts";

function expectApiHeaders(h: Headers): void {
  expect(h.get("content-type")).toBe("application/json");
  expect(h.get("cache-control")).toBe("no-store");
  expect(h.get("x-content-type-options")).toBe("nosniff");
  expect(h.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  expect(h.get("referrer-policy")).toBe("same-origin");
  expect(h.get("strict-transport-security")).toBe("max-age=31536000");
  for (const [k, v] of Object.entries(API_HEADERS)) expect(h.get(k)).toBe(v);
}

describe("security headers on Worker responses", () => {
  it("a browser API read", async () => {
    const r = await human.get("/api/state");
    expect(r.status).toBe(200);
    expectApiHeaders(r.headers);
  });

  it("an agent API 401 (no bearer token)", async () => {
    const r = await call("GET", "/agent/api/me", { host: "inbox.test" });
    expect(r.status).toBe(401);
    expectApiHeaders(r.headers);
  });

  it("an unknown API route (404) and a bad body (400)", async () => {
    const nf = await human.get("/api/nope");
    expect(nf.status).toBe(404);
    expectApiHeaders(nf.headers);
    const bad = await call("PUT", "/api/schedule", { body: "{" });
    expect(bad.status).toBe(400);
    expectApiHeaders(bad.headers);
  });

  it("a webhook refusal", async () => {
    const res = await exports.default.fetch("https://inbox.test/hooks/github", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expectApiHeaders(res.headers);
    await res.text();
  });

  it("/agent outside the API (never the SPA)", async () => {
    const res = await exports.default.fetch("https://inbox.test/agent/whatever");
    expect(res.status).toBe(404);
    expectApiHeaders(res.headers);
    await res.text();
  });
});
