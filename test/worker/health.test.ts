// GET /agent/api/health: unauthenticated (it sits behind the Access bypass for /agent), one D1 read, the newest
// migration applied. The deploy's smoke test checks it against migrations/ (docs/api.md).
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const MIGRATIONS = (env as unknown as { TEST_MIGRATIONS: { name: string }[] }).TEST_MIGRATIONS;

const get = (path: string, init: RequestInit = {}) => exports.default.fetch("https://inbox.test" + path, init);

describe("GET /agent/api/health", () => {
  it("answers 200 without a token, with the newest migration applied, and isn't cached", async () => {
    const res = await get("/agent/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const newest = MIGRATIONS.map((m) => m.name).sort().pop();
    expect(await res.json()).toEqual({ ok: true, migration: newest });
  });

  it("is only a GET (or HEAD), and nothing else under /agent/api opens without a token", async () => {
    expect((await get("/agent/api/health", { method: "HEAD" })).status).toBe(200);
    expect((await get("/agent/api/health", { method: "POST" })).status).toBe(401);
    expect((await get("/agent/api/me")).status).toBe(401);
    expect((await get("/agent/api/healthz")).status).toBe(401);
  });

  it("answers 503 when the database can't be read", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as typeof env;
    const { default: worker } = await import("../../worker/index.ts");
    const res = await worker.fetch(new Request("https://inbox.test/agent/api/health"), broken, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});
