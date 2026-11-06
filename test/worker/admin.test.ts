// ADMIN_EMAILS (deprecated, see users.test.ts for roles): with no admin in the
// users table, listed humans are admins and the rest deciders; unset (or
// blank) keeps every human an admin.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE } from "../../shared/types.ts";
import worker from "../../worker/index.ts";
import { human, mintToken } from "./helpers.ts";

// The dev human (you@test on localhost), or a bearer token, under extra env vars.
async function as(vars: Record<string, string>, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const host = token ? "inbox.test" : "localhost";
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ...env, ...vars },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ONLY_BOSS = { ADMIN_EMAILS: "boss@test" };
const schedule = { ...DEFAULT_SCHEDULE, pickup_interval_min: 15 };

describe("admins", () => {
  let managerSecret: string;
  beforeAll(async () => {
    managerSecret = (await mintToken("manager", undefined, "mgr-admin")).secret;
  });

  it("without ADMIN_EMAILS every human is an admin (today's behavior)", async () => {
    expect((await human.get("/api/me")).body).toEqual({ kind: "human", email: "you@test", role: "admin", is_admin: true });
    expect((await human.get("/api/state")).body.me.is_admin).toBe(true);
    expect((await human.get("/api/tokens")).status).toBe(200);
    expect((await human.put("/api/schedule", { schedule })).status).toBe(200);
  });

  it("a blank ADMIN_EMAILS counts as unset", async () => {
    for (const ADMIN_EMAILS of ["", " , "]) {
      expect((await as({ ADMIN_EMAILS }, "GET", "/api/me")).body.is_admin).toBe(true);
      expect((await as({ ADMIN_EMAILS }, "GET", "/api/tokens")).status).toBe(200);
    }
  });

  it("a listed human is an admin, whatever the case and spacing", async () => {
    const vars = { ADMIN_EMAILS: " boss@test , YOU@test " };
    expect((await as(vars, "GET", "/api/me")).body).toEqual({ kind: "human", email: "you@test", role: "admin", is_admin: true });
    expect((await as(vars, "POST", "/api/tokens", { name: "x", scope: "manager" })).status).toBe(201);
    expect((await as(vars, "PUT", "/api/schedule", { schedule })).status).toBe(200);
  });

  it("an unlisted human is a decider: 403 on tokens and schedule writes, and is_admin false", async () => {
    expect((await as(ONLY_BOSS, "GET", "/api/me")).body).toEqual({ kind: "human", email: "you@test", role: "decider", is_admin: false });
    expect((await as(ONLY_BOSS, "GET", "/api/state")).body.me.is_admin).toBe(false);
    const forbidden = [
      await as(ONLY_BOSS, "GET", "/api/tokens"),
      await as(ONLY_BOSS, "POST", "/api/tokens", { name: "x", scope: "manager" }),
      await as(ONLY_BOSS, "DELETE", "/api/tokens/abcdefghijkl"),
      await as(ONLY_BOSS, "PUT", "/api/schedule", { schedule }),
      await as(ONLY_BOSS, "PUT", "/api/meta/schedule", { data: schedule }),
      await as(ONLY_BOSS, "PATCH", "/api/meta/schedule", { data: { pickup_interval_min: 5 } }),
    ];
    for (const r of forbidden) {
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("forbidden");
    }
  });

  it("an unlisted human still reads the schedule and requests ticks; other meta writes are an admin's", async () => {
    expect((await as(ONLY_BOSS, "GET", "/api/schedule")).status).toBe(200);
    expect((await as(ONLY_BOSS, "POST", "/api/meta/manager/tick-request", {})).status).toBe(200);
    expect((await as(ONLY_BOSS, "PATCH", "/api/meta/manager", { data: { digest: "d" } })).status).toBe(403);
  });

  it("the manager token keeps schedule rights and still can't manage tokens", async () => {
    expect((await as(ONLY_BOSS, "PUT", "/api/schedule", { schedule }, managerSecret)).status).toBe(200);
    expect((await as(ONLY_BOSS, "PATCH", "/api/meta/schedule", { data: { sweep_interval_min: 45 } }, managerSecret)).status).toBe(200);
    expect((await as(ONLY_BOSS, "GET", "/api/tokens", undefined, managerSecret)).status).toBe(403);
    expect((await as(ONLY_BOSS, "GET", "/api/me", undefined, managerSecret)).body).toEqual({
      kind: "token",
      name: "mgr-admin",
      scope: "manager",
      fleet: "default",
    });
  });
});
