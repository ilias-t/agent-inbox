// /api/people: each human sets their own display name and ntfy topic, whatever
// their role. Others see names and whether a topic is set, never the topic:
// on ntfy.sh knowing a topic is enough to subscribe to it. Stored on the
// person's users row (worker/users.ts); before migration 0005 this was the
// meta/people doc, and these routes kept its shapes.

import type { Person } from "../../shared/types.ts";
import { requireFull, requireHuman } from "../auth.ts";
import { badRequest, json, optString } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { toPerson, type UserRow } from "../users.ts";

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function listPeople(db: D1Database): Promise<Person[]> {
  const { results } = await db.prepare("SELECT email, name, ntfy_topic FROM users ORDER BY email").all<UserRow>();
  return results.map(toPerson);
}

function myEmail(c: Ctx): string {
  requireHuman(c.caller);
  return c.caller.principal.kind === "human" ? c.caller.principal.email.toLowerCase() : "";
}

// A trimmed string, or undefined when absent, null or blank (which clears it).
function field(body: Record<string, unknown>, key: string, max: number): string | undefined {
  return optString(body, key, max)?.trim() || undefined;
}

async function list(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  return json({ people: await listPeople(c.env.DB) });
}

async function getMe(c: Ctx): Promise<Response> {
  const email = myEmail(c);
  const row = await c.env.DB.prepare("SELECT name, ntfy_topic FROM users WHERE email = ?").bind(email).first<UserRow>();
  return json({ email, ...(row?.name ? { name: row.name } : {}), ...(row?.ntfy_topic ? { ntfy_topic: row.ntfy_topic } : {}) });
}

// Replaces the caller's name and topic (an omitted field clears it); never
// their role. Clearing both removes a row that has no role, as an empty entry
// left meta/people.
async function putMe(c: Ctx): Promise<Response> {
  const email = myEmail(c);
  const body = await c.body();
  const name = field(body, "name", 100) ?? null;
  const topic = field(body, "ntfy_topic", 200) ?? null;
  if (topic && !TOPIC_RE.test(topic)) throw badRequest("ntfy_topic must be 1-64 letters, digits, - or _");
  const db = c.env.DB, actor = c.caller.actor;
  if (name || topic) {
    await db
      .prepare(
        `INSERT INTO users (email, role, name, ntfy_topic, created_at, updated_at, updated_by) VALUES (?1, NULL, ?2, ?3, ?4, ?4, ?5)
         ON CONFLICT (email) DO UPDATE SET name = ?2, ntfy_topic = ?3, updated_at = ?4, updated_by = ?5`,
      )
      .bind(email, name, topic, c.now, actor)
      .run();
  } else {
    await db.batch([
      db.prepare("DELETE FROM users WHERE email = ? AND role IS NULL").bind(email),
      db.prepare("UPDATE users SET name = NULL, ntfy_topic = NULL, updated_at = ?2, updated_by = ?3 WHERE email = ?1")
        .bind(email, c.now, actor),
    ]);
  }
  return json({ email, ...(name ? { name } : {}), ...(topic ? { ntfy_topic: topic } : {}) });
}

export const peopleRoutes: Route[] = [
  ["GET", "/people", list],
  ["GET", "/people/me", getMe],
  ["PUT", "/people/me", putMe],
];
