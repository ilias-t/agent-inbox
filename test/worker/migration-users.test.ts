// Migration 0005 against a database as it is before it: meta/people holds
// everyone's names and topics, and there is no users table yet. Each test
// rewinds to that state, runs 0005's statements, and checks nothing is lost
// and nobody's access changes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { callAs } from "./helpers.ts";

const M0005 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0005"))!;

// The live shape: keys are the lowercased emails /api/people/me wrote.
const PEOPLE = {
  "you@example.com": { name: "You", ntfy_topic: "agent-inbox-0123456789abcdef01234567" },
  "alice@example.com": { ntfy_topic: "alice-topic" },
  "bob@example.com": { name: "Bob" },
  "Dan@Example.com": { name: " Dan " }, // hand-edited: mixed case, padding
  "carol@example.com": {},
  "junk@example.com": "not an object",
};
const DOC_CREATED = "2026-09-01T10:00:00.000Z", DOC_UPDATED = "2026-10-01T12:00:00.000Z";

async function rewind(people: unknown | null) {
  await env.DB.batch([
    env.DB.prepare("DROP TABLE IF EXISTS users"), // drops its triggers too
    env.DB.prepare("DELETE FROM docs WHERE collection = 'meta' AND id = 'people'"),
  ]);
  if (people !== null) {
    await env.DB.prepare(
      `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by)
       VALUES ('meta', 'people', ?, 7, ?, ?, 'human:you@example.com')`,
    )
      .bind(JSON.stringify(people), DOC_CREATED, DOC_UPDATED)
      .run();
  }
}

const migrate = () => env.DB.batch(M0005.queries.map((q) => env.DB.prepare(q)));
const users = async () =>
  (await env.DB.prepare("SELECT email, role, name, ntfy_topic, created_at, updated_at, updated_by FROM users ORDER BY email").all()).results;

describe("migration 0005_users", () => {
  it("copies every person's name and topic from meta/people, with no role", async () => {
    await rewind(PEOPLE);
    const before = (await env.DB.prepare("SELECT max(seq) AS s FROM changes").first<{ s: number }>())!.s;
    await migrate();
    const row = (email: string, name: string | null, topic: string | null) => ({
      email, role: null, name, ntfy_topic: topic, created_at: DOC_CREATED, updated_at: DOC_UPDATED, updated_by: "migration:0005",
    });
    expect(await users()).toEqual([
      row("alice@example.com", null, "alice-topic"),
      row("bob@example.com", "Bob", null),
      row("carol@example.com", null, null),
      row("dan@example.com", "Dan", null),
      row("you@example.com", "You", "agent-inbox-0123456789abcdef01234567"),
    ]);
    // meta/people stays as it was (a rolled-back Worker still reads it), and the copy logged no changes.
    const doc = await env.DB.prepare("SELECT data, version FROM docs WHERE collection = 'meta' AND id = 'people'").first<{ data: string; version: number }>();
    expect(JSON.parse(doc!.data)).toEqual(PEOPLE);
    expect(doc!.version).toBe(7);
    expect((await env.DB.prepare("SELECT max(seq) AS s FROM changes").first<{ s: number }>())!.s).toBe(before);
  });

  it("leaves everyone's access as it was: no admin row, so humans stay admins (ADMIN_EMAILS unset)", async () => {
    await rewind(PEOPLE);
    await migrate();
    for (const email of ["you@example.com", "alice@example.com", "someone-new@example.com"]) {
      expect((await callAs(email, "GET", "/api/me")).body).toMatchObject({ role: "admin", is_admin: true });
    }
    expect((await callAs("you@example.com", "GET", "/api/people/me")).body).toEqual({
      email: "you@example.com", name: "You", ntfy_topic: "agent-inbox-0123456789abcdef01234567",
    });
    expect((await callAs("you@example.com", "GET", "/api/people")).body.people).toContainEqual({
      email: "alice@example.com", has_topic: true,
    });
    // ADMIN_EMAILS set: listed humans admin, the rest deciders, as before roles.
    const vars = { ADMIN_EMAILS: "you@example.com" };
    expect((await callAs("you@example.com", "GET", "/api/me", undefined, vars)).body.role).toBe("admin");
    expect((await callAs("alice@example.com", "GET", "/api/me", undefined, vars)).body.role).toBe("decider");
  });

  it("works without meta/people, and with an empty or non-object doc", async () => {
    for (const people of [null, {}, ["x@example.com"]]) {
      await rewind(people);
      await migrate();
      expect(await users()).toEqual([]);
    }
  });
});
