// /api/users: people and their roles (worker/users.ts says how a role
// resolves). Everyone but orchestrator tokens reads the list; only admin
// humans change it, never a token, so a leaked manager token can't make
// anyone an admin. Topics never leave the Worker here, not even for admins.

import { ROLES, type Role, type UsersResponse } from "../../shared/types.ts";
import { requireAdmin, requireFull } from "../auth.ts";
import { badRequest, HttpError, json, notFound, optString } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { deviceCounts, deviceOnlyInfo, loadUsers, USER_COLS, userInfo, type UserRow } from "../users.ts";

const lastAdmin = () =>
  new HttpError(409, "last_admin", "That would leave no admin. Make someone else an admin first.");

async function list(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  const { rows, hasAdmin } = await loadUsers(c.env.DB);
  const p = c.caller.principal;
  const full = p.kind === "human" && p.role === "admin";
  if (!full) return json({ users: rows.map((r) => userInfo(c.env, r, hasAdmin, false)) } satisfies UsersResponse);
  // Admins also see everyone with Web Push devices but no row, so they can remove them.
  const devices = await deviceCounts(c.env.DB);
  const users = rows.map((r) => userInfo(c.env, r, hasAdmin, true, devices.get(r.email) ?? 0));
  const saved = new Set(rows.map((r) => r.email));
  for (const [email, n] of devices) if (!saved.has(email)) users.push(deviceOnlyInfo(c.env, email, n, hasAdmin));
  users.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return json({ users, bootstrap: !hasAdmin } satisfies UsersResponse);
}

function roleField(v: unknown): Role {
  if (!ROLES.includes(v as Role)) throw badRequest(`role must be one of ${ROLES.join(", ")}`);
  return v as Role;
}

const roleOfRow = (db: D1Database, email: string) =>
  db.prepare("SELECT role FROM users WHERE email = ?").bind(email).first<{ role: Role | null }>();

// Body: {role?, name?}. Adding someone needs a role; an omitted field keeps
// what is saved, and a null or blank name clears it. An admin who isn't saved
// as one yet (bootstrap, or ADMIN_EMAILS) is saved as admin in the same
// transaction: otherwise making someone else admin would end bootstrap and
// leave its author a viewer.
async function put(c: Ctx): Promise<Response> {
  requireAdmin(c.caller);
  const email = c.params.email;
  const body = await c.body();
  const role = body.role === undefined ? undefined : roleField(body.role);
  const setName = "name" in body;
  const name = setName ? optString(body, "name", 100)?.trim() || null : null;
  const db = c.env.DB, actor = c.caller.actor, now = c.now;
  const me = c.caller.principal.kind === "human" ? c.caller.principal.email.toLowerCase() : "";

  const existing = await roleOfRow(db, email);
  if (!existing && role === undefined) throw badRequest("role is required to add someone");
  const mine = email === me ? existing : await roleOfRow(db, me);
  const claim = mine?.role !== "admin";
  if (claim && email === me && role !== undefined && role !== "admin") {
    // Not saved as admin, demoting themselves: fine only while another admin is saved.
    const other = await db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").first();
    if (!other) throw lastAdmin();
  }

  const writes: D1PreparedStatement[] = [];
  if (claim && email !== me) {
    writes.push(
      db.prepare(
        `INSERT INTO users (email, role, created_at, updated_at, updated_by) VALUES (?1, 'admin', ?2, ?2, ?3)
         ON CONFLICT (email) DO UPDATE SET role = 'admin', updated_at = ?2, updated_by = ?3`,
      ).bind(me, now, actor),
    );
  }
  // The guard re-checks the last admin in the write itself, so two admins
  // demoting each other at once can't both land.
  writes.push(
    db.prepare(
      `INSERT INTO users (email, role, name, created_at, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?4, ?5)
       ON CONFLICT (email) DO UPDATE SET
         role = CASE WHEN ?6 THEN excluded.role ELSE users.role END,
         name = CASE WHEN ?7 THEN excluded.name ELSE users.name END,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by
       WHERE NOT (?6 AND users.role = 'admin' AND excluded.role IS NOT 'admin'
                  AND (SELECT count(*) FROM users WHERE role = 'admin') <= 1)
       RETURNING ${USER_COLS}`,
    ).bind(email, role ?? null, name, now, actor, role !== undefined ? 1 : 0, setName ? 1 : 0),
  );
  const results = await db.batch<UserRow>(writes);
  const row = results[results.length - 1].results[0];
  if (!row) throw lastAdmin();
  const { hasAdmin } = await loadUsers(db);
  const devices = (await deviceCounts(db, email)).get(email) ?? 0;
  return json(userInfo(c.env, row, hasAdmin, true, devices), existing ? 200 : 201);
}

// Removes the row (role, name and topic), if any, and the person's Web Push
// devices, which can exist without a row (anyone Access lets in can enable
// one). 404 only when there was neither. Access still decides who gets in:
// someone removed here who can still sign in is a viewer, or whatever the
// defaults make them.
async function del(c: Ctx): Promise<Response> {
  requireAdmin(c.caller);
  const email = c.params.email;
  const db = c.env.DB;
  // One transaction; the devices go only once no row is left, so refusing to
  // remove the last admin leaves their devices too.
  const [row, devices] = await db.batch<{ email: string }>([
    db.prepare(
      `DELETE FROM users WHERE email = ?1
         AND NOT (role IS 'admin' AND (SELECT count(*) FROM users WHERE role = 'admin') <= 1)
       RETURNING email`,
    ).bind(email),
    db.prepare("DELETE FROM push_subscriptions WHERE email = ?1 AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?1)").bind(email),
  ]);
  if (!row.results.length) {
    if (await roleOfRow(db, email)) throw lastAdmin();
    if (!devices.meta.changes) throw notFound(`No user or device for ${email}`);
  }
  return json({ ok: true });
}

export const userRoutes: Route[] = [
  ["GET", "/users", list],
  ["PUT", "/users/:email", put],
  ["DELETE", "/users/:email", del],
];
