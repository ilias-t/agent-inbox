import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TOKEN_RE, mintToken, tokenInsertSql, tokenInserted, validateTokenArgs } from "../../scripts/lib/token.mjs";

describe("mintToken", () => {
  it("mints ait_<12 base32>_<43 base64url> and hashes the secret string", () => {
    for (let i = 0; i < 50; i++) {
      const t = mintToken();
      const m = TOKEN_RE.exec(t.token);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(t.id);
      expect(m![2]).toBe(t.secret);
      expect(t.id).toMatch(/^[a-z2-7]{12}$/);
      expect(Buffer.from(t.secret, "base64url")).toHaveLength(32);
      expect(t.secret_hash).toBe(createHash("sha256").update(t.secret).digest("hex"));
    }
  });

  it("maps random bytes onto the base32 alphabet", () => {
    const t = mintToken((n: number) => Buffer.alloc(n, 31));
    expect(t.id).toBe("777777777777");
    expect(t.secret).toBe(Buffer.alloc(32, 31).toString("base64url"));
  });
});

describe("tokenInsertSql", () => {
  const NOW = "2026-10-07T00:00:00.000Z";

  it("stores the hash and never the secret, guarded on the name being free", () => {
    const t = mintToken();
    const sql = tokenInsertSql(t, { name: "o3's token", scope: "orchestrator", orchestrator: "O3" }, NOW);
    expect(sql).toContain(t.secret_hash);
    expect(sql).not.toContain(t.secret);
    expect(sql).toBe(
      `INSERT INTO tokens (id, name, scope, orchestrator, secret_hash, created_at, created_by) ` +
        `SELECT '${t.id}', 'o3''s token', 'orchestrator', 'O3', '${t.secret_hash}', '${NOW}', 'script' ` +
        `WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE name = 'o3''s token' AND revoked_at IS NULL); ` +
        `SELECT count(*) AS inserted FROM tokens WHERE id = '${t.id}';`,
    );
  });

  it("writes NULL orchestrator for manager tokens", () => {
    expect(tokenInsertSql(mintToken(), { name: "manager", scope: "manager" })).toContain("'manager', NULL,");
  });

  it("inserts nothing when a live token has the name (real SQLite, the D1 schema)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
    const run = (name: string) => {
      const [insert, count] = tokenInsertSql(mintToken(), { name, scope: "manager" }, NOW).split("; ");
      db.exec(insert);
      return { ...db.prepare(count).get() };
    };
    expect(run("mgr")).toEqual({ inserted: 1 });
    expect(run("mgr")).toEqual({ inserted: 0 });
    expect(run("other")).toEqual({ inserted: 1 });
    db.exec("UPDATE tokens SET revoked_at = 'x' WHERE name = 'mgr'");
    expect(run("mgr")).toEqual({ inserted: 1 });
    expect({ ...db.prepare("SELECT count(*) AS n FROM tokens WHERE name = 'mgr'").get() }).toEqual({ n: 2 });
  });
});

describe("tokenInserted", () => {
  // `wrangler d1 execute --command ... --json`: one result per statement.
  const out = (n: number) => JSON.stringify([{ results: [], success: true }, { results: [{ inserted: n }], success: true }]);

  it("reads the count the last statement returned", () => {
    expect(tokenInserted(out(1))).toBe(true);
    expect(tokenInserted(out(0))).toBe(false);
  });

  it("throws on output it can't read, rather than guessing", () => {
    expect(() => tokenInserted("not json")).toThrow(/wrangler/);
    expect(() => tokenInserted(JSON.stringify([{ results: [] }]))).toThrow(/wrangler/);
  });
});

describe("validateTokenArgs", () => {
  it("requires name, a known scope and an orchestrator for orchestrator scope", () => {
    expect(validateTokenArgs({ name: "m", scope: "manager" })).toBeNull();
    expect(validateTokenArgs({ name: "o", scope: "orchestrator", orchestrator: "O3" })).toBeNull();
    expect(validateTokenArgs({ scope: "manager" })).toMatch(/--name/);
    expect(validateTokenArgs({ name: "x", scope: "admin" })).toMatch(/--scope/);
    expect(validateTokenArgs({ name: "x", scope: "orchestrator" })).toMatch(/--orchestrator is required/);
    expect(validateTokenArgs({ name: "x", scope: "manager", orchestrator: "O3" })).toMatch(/only applies/);
    expect(validateTokenArgs({ name: "x", scope: "orchestrator", orchestrator: "bad id" })).toMatch(/invalid/);
  });
});
