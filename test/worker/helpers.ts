import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { Doc, Item } from "../../shared/types.ts";
import worker from "../../worker/index.ts";

export interface CallOpts {
  body?: unknown;
  token?: string;
  // localhost = the DEV_NO_ACCESS human; any other host needs real credentials.
  host?: string;
  headers?: Record<string, string>;
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(method: string, path: string, opts: CallOpts = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  // Like the UI: every write is JSON, bodiless ones too (CSRF check).
  if (method !== "GET" && method !== "HEAD") headers["Content-Type"] ??= "application/json";
  const res = await exports.default.fetch(`http://${opts.host ?? "localhost"}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export const human = {
  get: <T = any>(path: string) => call<T>("GET", path),
  put: <T = any>(path: string, body: unknown) => call<T>("PUT", path, { body }),
  patch: <T = any>(path: string, body: unknown) => call<T>("PATCH", path, { body }),
  post: <T = any>(path: string, body: unknown = {}) => call<T>("POST", path, { body }),
  del: <T = any>(path: string) => call<T>("DELETE", path),
};

// A bearer-token client on the /agent prefix.
export function agent(token: string) {
  const host = "inbox.test";
  return {
    get: <T = any>(path: string) => call<T>("GET", `/agent${path}`, { token, host }),
    put: <T = any>(path: string, body: unknown) => call<T>("PUT", `/agent${path}`, { body, token, host }),
    patch: <T = any>(path: string, body: unknown) => call<T>("PATCH", `/agent${path}`, { body, token, host }),
    post: <T = any>(path: string, body: unknown = {}) => call<T>("POST", `/agent${path}`, { body, token, host }),
    del: <T = any>(path: string) => call<T>("DELETE", `/agent${path}`, { token, host }),
  };
}

// Live token names are unique, so the default name is too.
export async function mintToken(scope: "manager" | "orchestrator", orchestrator?: string, name?: string) {
  const r = await human.post("/api/tokens", { name: name ?? uid(`${scope}-${orchestrator ?? "x"}`), scope, orchestrator });
  expect(r.status).toBe(201);
  return r.body as { token: { id: string; name: string }; secret: string };
}

let n = 0;
export const uid = (prefix = "t") => `${prefix}-${Date.now().toString(36)}-${n++}`;

export async function createItem(id: string, data: Partial<Item> = {}): Promise<Doc<Item>> {
  const r = await human.put(`/api/items/${id}`, { data: { type: "decision", title: `Item ${id}`, ...data } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

// Replaces everyone in the users table, as several people would have saved
// their names and topics over time. No role unless an entry sets one.
export async function setPeople(data: Record<string, { name?: string; ntfy_topic?: string; role?: string }>) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM users"),
    ...Object.entries(data).map(([email, p]) =>
      env.DB.prepare(
        "INSERT INTO users (email, role, name, ntfy_topic, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'test')",
      ).bind(email, p.role ?? null, p.name ?? null, p.ntfy_topic ?? null, now, now),
    ),
  ]);
}

// Sets roles directly, as an admin would have in Settings (null: no role).
export async function setRoles(roles: Record<string, string | null>) {
  const now = new Date().toISOString();
  await env.DB.batch(
    Object.entries(roles).map(([email, role]) =>
      env.DB.prepare(
        `INSERT INTO users (email, role, created_at, updated_at, updated_by) VALUES (?1, ?2, ?3, ?3, 'test')
         ON CONFLICT (email) DO UPDATE SET role = ?2, updated_at = ?3`,
      ).bind(email, role, now),
    ),
  );
}

export const clearUsers = () => env.DB.prepare("DELETE FROM users").run();

// A human signed in as `email` (DEV_NO_ACCESS with DEV_USER_EMAIL), under
// extra env vars such as ADMIN_EMAILS. Waits for waitUntil work.
export async function callAs<T = any>(
  email: string,
  method: string,
  path: string,
  body?: unknown,
  vars: Record<string, string | undefined> = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") headers["Content-Type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ...env, DEV_USER_EMAIL: email, ...vars },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export function person(email: string, vars: Record<string, string | undefined> = {}) {
  return {
    get: <T = any>(path: string) => callAs<T>(email, "GET", path, undefined, vars),
    put: <T = any>(path: string, body: unknown) => callAs<T>(email, "PUT", path, body, vars),
    patch: <T = any>(path: string, body: unknown) => callAs<T>(email, "PATCH", path, body, vars),
    post: <T = any>(path: string, body: unknown = {}) => callAs<T>(email, "POST", path, body, vars),
    del: <T = any>(path: string, body?: unknown) => callAs<T>(email, "DELETE", path, body, vars),
  };
}
