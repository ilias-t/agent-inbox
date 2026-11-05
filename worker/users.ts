// People and their roles: the users table (migration 0005), which replaced the
// meta/people doc and the ADMIN_EMAILS env var. One row per person, keyed by
// lowercased email, holding their role (or none) and what they set for
// themselves (name, ntfy topic).
//
// A human's role, in order:
//   1. Their row's role, when an admin saved one.
//   2. Listed in ADMIN_EMAILS (deprecated; a bootstrap override): admin.
//   3. No admin saved yet (bootstrap): admin, or decider when ADMIN_EMAILS is
//      set. That is how a deployment behaved before roles, so a live one keeps
//      working unchanged until someone saves an admin.
//   4. Otherwise viewer: someone Access lets in without a row can only read.

import type { Person, Role, UserInfo } from "../shared/types.ts";
import type { Env } from "./env.ts";

export interface UserRow {
  email: string;
  role: Role | null;
  name: string | null;
  ntfy_topic: string | null;
  created_at: string;
  updated_at: string;
}

export const USER_COLS = "email, role, name, ntfy_topic, created_at, updated_at";

const RANK: Record<Role, number> = { viewer: 0, decider: 1, admin: 2 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Steps 2-4 above: the role of someone without a saved one. `hasAdmin`: the
// table has an admin row.
export function defaultRole(env: Env, email: string, hasAdmin: boolean): Role {
  const listed = adminEmails(env);
  if (listed.includes(email.toLowerCase())) return "admin";
  if (hasAdmin) return "viewer";
  return listed.length ? "decider" : "admin";
}

export const roleOf = (env: Env, row: Pick<UserRow, "email" | "role">, hasAdmin: boolean): Role =>
  row.role ?? defaultRole(env, row.email, hasAdmin);

// One query per human request.
export async function resolveRole(env: Env, email: string): Promise<Role> {
  const e = email.toLowerCase();
  const r = await env.DB.prepare(
    "SELECT (SELECT role FROM users WHERE email = ?1) AS role, EXISTS (SELECT 1 FROM users WHERE role = 'admin') AS has_admin",
  )
    .bind(e)
    .first<{ role: Role | null; has_admin: number }>();
  return r?.role ?? defaultRole(env, e, !!r?.has_admin);
}

export async function loadUsers(db: D1Database): Promise<{ rows: UserRow[]; hasAdmin: boolean }> {
  const { results } = await db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY email`).all<UserRow>();
  return { rows: results, hasAdmin: results.some((r) => r.role === "admin") };
}

// As teammates see a person: the name and whether a topic is set, never the topic.
export function toPerson(r: Pick<UserRow, "email" | "name" | "ntfy_topic">): Person {
  return r.name ? { email: r.email, name: r.name, has_topic: !!r.ntfy_topic } : { email: r.email, has_topic: !!r.ntfy_topic };
}

// GET /api/users entries: the admin view (with `devices`, the person's Web Push
// subscriptions), or email, name and role for everyone else.
export function userInfo(env: Env, r: UserRow, hasAdmin: boolean, full: boolean, devices = 0): UserInfo {
  const base: UserInfo = r.name ? { email: r.email, name: r.name, role: roleOf(env, r, hasAdmin) } : { email: r.email, role: roleOf(env, r, hasAdmin) };
  if (!full) return base;
  return { ...base, role_set: r.role !== null, has_row: true, devices, has_topic: !!r.ntfy_topic, created_at: r.created_at, updated_at: r.updated_at };
}

// Web Push subscriptions per email. Anyone Access lets in can enable a device
// without having a users row, so admins need these to see (and remove) them.
export async function deviceCounts(db: D1Database, email?: string): Promise<Map<string, number>> {
  const q = email
    ? db.prepare("SELECT email, count(*) AS n FROM push_subscriptions WHERE email = ? GROUP BY email").bind(email)
    : db.prepare("SELECT email, count(*) AS n FROM push_subscriptions GROUP BY email");
  const { results } = await q.all<{ email: string; n: number }>();
  return new Map(results.map((r) => [r.email, r.n]));
}

// The admin entry for someone with devices but no row: the role they'd resolve to.
export function deviceOnlyInfo(env: Env, email: string, devices: number, hasAdmin: boolean): UserInfo {
  return { email, role: defaultRole(env, email, hasAdmin), role_set: false, has_row: false, devices, has_topic: false };
}

// ntfy topics of people who can act on a push (its decide buttons work for
// whoever taps them), keyed by email: viewers are left out.
export async function actingTopics(env: Env): Promise<Map<string, string>> {
  const { rows, hasAdmin } = await loadUsers(env.DB);
  return new Map(
    rows.filter((r) => r.ntfy_topic && roleOf(env, r, hasAdmin) !== "viewer").map((r) => [r.email, r.ntfy_topic as string]),
  );
}
