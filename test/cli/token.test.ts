import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TOKEN_RE, mintToken, tokenInsertSql, tokenOutcome, validateTokenArgs } from "../../scripts/lib/token.mjs";

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

// A database with every migration applied, as the script's statement runs against D1.
function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return db;
}

describe("tokenInsertSql", () => {
  const NOW = "2026-10-07T00:00:00.000Z";

  it("stores the hash and never the secret, on one line", () => {
    const t = mintToken();
    const sql = tokenInsertSql(t, { name: "o3's token", scope: "orchestrator", orchestrator: "O3" }, NOW);
    expect(sql).toContain(t.secret_hash);
    expect(sql).not.toContain(t.secret);
    expect(sql).toContain("'o3''s token'");
    expect(sql).not.toContain("\n");
  });

  // Runs the script's statements as `wrangler d1 execute` would, and the outcome as tokenOutcome reads it.
  const runner = (db: DatabaseSync) => (args: Parameters<typeof tokenInsertSql>[1]) => {
    const t = mintToken();
    const statements = tokenInsertSql(t, args, NOW).replace(/;$/, "").split("; ");
    const results = statements.map((s) => ({ results: db.prepare(s).all().map((r) => ({ ...r })) }));
    return { ...tokenOutcome(JSON.stringify(results), args), id: t.id };
  };
  const fleetOf = (db: DatabaseSync, id: string) => ({ ...db.prepare("SELECT fleet FROM tokens WHERE id = ?").get(id) }).fleet;
  const register = (db: DatabaseSync, fleet: string) =>
    db.prepare("INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES ('fleets', ?, '{}', 'x', 'x')").run(fleet);

  it("inserts nothing when a live token has the name", () => {
    const db = migrated();
    const run = runner(db);
    expect(run({ name: "mgr", scope: "manager" }).inserted).toBe(true);
    const again = run({ name: "mgr", scope: "manager" });
    expect(again.inserted).toBe(false);
    expect(again.refusal).toEqual({ status: 409, message: expect.stringMatching(/already named "mgr"/) });
    expect(run({ name: "other", scope: "manager" }).inserted).toBe(true);
    db.exec("UPDATE tokens SET revoked_at = 'x' WHERE name = 'mgr'");
    expect(run({ name: "mgr", scope: "manager" }).inserted).toBe(true);
    expect({ ...db.prepare("SELECT count(*) AS n FROM tokens WHERE name = 'mgr'").get() }).toEqual({ n: 2 });
  });

  it("mints for the default fleet or a registered one, and refuses an unregistered one", () => {
    const db = migrated();
    const run = runner(db);
    const d = run({ name: "d", scope: "manager" });
    expect(d).toMatchObject({ inserted: true, fleet: "default" });
    expect(fleetOf(db, d.id)).toBeNull();
    expect(run({ name: "d2", scope: "manager", fleet: "default" })).toMatchObject({ inserted: true, fleet: "default" });
    const typo = run({ name: "fa", scope: "manager", fleet: "fa" });
    expect(typo).toMatchObject({ inserted: false, refusal: { status: 400, message: expect.stringMatching(/No fleet fa/) } });
    register(db, "fa");
    const fa = run({ name: "fa", scope: "manager", fleet: "fa" });
    expect(fa).toMatchObject({ inserted: true, fleet: "fa" });
    expect(fleetOf(db, fa.id)).toBe("fa");
  });

  it("gives a manager token the fleet that owns its id: its doc, else its routine, else a live token", () => {
    const db = migrated();
    const run = runner(db);
    for (const f of ["fa", "fb"]) register(db, f);
    // No owner yet: the fleet asked for, else the default fleet.
    expect(run({ name: "o1", scope: "orchestrator", orchestrator: "O1" })).toMatchObject({ inserted: true, fleet: "default" });
    expect(run({ name: "o2", scope: "orchestrator", orchestrator: "O2", fleet: "fa" })).toMatchObject({ inserted: true, fleet: "fa" });
    // A live token owns its id: left out, the fleet is inherited; another one is refused, "default" included.
    expect(run({ name: "o2b", scope: "orchestrator", orchestrator: "O2" })).toMatchObject({ inserted: true, fleet: "fa" });
    const other = run({ name: "o2c", scope: "orchestrator", orchestrator: "O2", fleet: "fb" });
    expect(other.refusal).toEqual({ status: 409, message: expect.stringMatching(/Manager O2 belongs to fleet fa/) });
    expect(run({ name: "o2d", scope: "orchestrator", orchestrator: "O2", fleet: "default" }).refusal?.status).toBe(409);
    expect(run({ name: "o1b", scope: "orchestrator", orchestrator: "O1", fleet: "fa" }).refusal?.message).toMatch(/belongs to fleet default/);
    // A revoked token owns nothing.
    db.exec("UPDATE tokens SET revoked_at = 'x' WHERE orchestrator = 'O1'");
    expect(run({ name: "o1c", scope: "orchestrator", orchestrator: "O1", fleet: "fa" })).toMatchObject({ inserted: true, fleet: "fa" });
    // The manager doc comes first, then the routine: after an admin move they may disagree.
    db.exec(`INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES ('orchestrators', 'O2', '{"fleet":"fb"}', 'x', 'x')`);
    expect(run({ name: "o2e", scope: "orchestrator", orchestrator: "O2" })).toMatchObject({ inserted: true, fleet: "fb" });
    db.exec("INSERT INTO review_routines (routine, version, updated_at, fleet) VALUES ('R1', 1, 'x', 'fb')");
    expect(run({ name: "r1", scope: "orchestrator", orchestrator: "R1" })).toMatchObject({ inserted: true, fleet: "fb" });
    db.exec(`INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES ('orchestrators', 'R1', '{}', 'x', 'x')`);
    expect(run({ name: "r1b", scope: "orchestrator", orchestrator: "R1", fleet: "fb" }).refusal?.message).toMatch(/belongs to fleet default/);
  });

  it("registers the fleet with --create-fleet only once the token is stored", () => {
    const db = migrated();
    const run = runner(db);
    const fleets = () => db.prepare("SELECT id, data, version FROM docs WHERE collection = 'fleets' ORDER BY id").all().map((r) => ({ ...r }));
    const changes = () => ({ ...db.prepare("SELECT count(*) AS n FROM changes WHERE collection = 'fleets'").get() }).n;
    run({ name: "taken", scope: "manager" });
    expect(run({ name: "taken", scope: "manager", fleet: "fa", createFleet: true }).inserted).toBe(false);
    expect(fleets()).toEqual([]);
    expect(changes()).toBe(0);
    expect(run({ name: "fa", scope: "manager", fleet: "fa", createFleet: true })).toMatchObject({ inserted: true, fleet: "fa" });
    expect(fleets()).toEqual([{ id: "fa", data: "{}", version: 1 }]);
    expect(changes()).toBe(1);
    // An existing fleet doc is left as it is.
    db.exec(`UPDATE docs SET data = '{"label":"A"}' WHERE collection = 'fleets' AND id = 'fa'`);
    expect(run({ name: "fa2", scope: "manager", fleet: "fa", createFleet: true }).inserted).toBe(true);
    expect(fleets()).toEqual([{ id: "fa", data: '{"label":"A"}', version: 1 }]);
    // A refused manager token registers nothing either.
    run({ name: "o9", scope: "orchestrator", orchestrator: "O9" });
    expect(run({ name: "o9b", scope: "orchestrator", orchestrator: "O9", fleet: "fz", createFleet: true }).inserted).toBe(false);
    expect(fleets().map((f) => f.id)).toEqual(["fa"]);
  });
});

describe("tokenOutcome", () => {
  // `wrangler d1 execute --command ... --json`: one result per statement.
  const out = (row: object) => JSON.stringify([{ results: [], success: true }, { results: [row], success: true }]);

  it("reads the outcome row the last statement returned", () => {
    expect(tokenOutcome(out({ inserted: 1, fleet: "fa" }), { name: "n" })).toEqual({ inserted: true, fleet: "fa" });
    expect(tokenOutcome(out({ inserted: 0, name_taken: 1, owner: null, fleet: "default", fleet_known: 1 }), { name: "n" }).refusal?.status).toBe(409);
  });

  it("throws on output it can't read, rather than guessing", () => {
    expect(() => tokenOutcome("not json", { name: "n" })).toThrow(/wrangler/);
    expect(() => tokenOutcome(JSON.stringify([{ results: [] }]), { name: "n" })).toThrow(/wrangler/);
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

  it("takes default or a fleet id, and --create-fleet only with a named fleet", () => {
    expect(validateTokenArgs({ name: "x", scope: "manager", fleet: "default" })).toBeNull();
    expect(validateTokenArgs({ name: "x", scope: "manager", fleet: "side-a" })).toBeNull();
    expect(validateTokenArgs({ name: "x", scope: "manager", fleet: "Side A" })).toMatch(/--fleet/);
    expect(validateTokenArgs({ name: "x", scope: "manager", fleet: "side-a", createFleet: true })).toBeNull();
    expect(validateTokenArgs({ name: "x", scope: "manager", createFleet: true })).toMatch(/--create-fleet/);
    expect(validateTokenArgs({ name: "x", scope: "manager", fleet: "default", createFleet: true })).toMatch(/--create-fleet/);
  });
});
