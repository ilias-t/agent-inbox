// Migrations apply to the live D1 on every merge to main (deploy.yml), before anyone looks again. The guard
// (scripts/lib/migration-guard.mjs) fails the check on a statement that destroys data: DROP TABLE, DROP COLUMN or
// a RENAME. A migration that means it says so in a comment: `-- migration-guard: allow <why>` (docs/deploy.md).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { destructive, guardProblems } from "../../scripts/lib/migration-guard.mjs";

describe("destructive", () => {
  it("finds DROP TABLE, DROP COLUMN and RENAME, with their line", () => {
    const sql = "CREATE TABLE a (x TEXT);\nDROP TABLE IF EXISTS b;\nALTER TABLE c DROP COLUMN d;\nALTER TABLE e RENAME TO f;\nALTER TABLE g RENAME COLUMN h TO i;\nalter table j\n  drop k;";
    expect(destructive(sql).map((f) => [f.line, f.kind])).toEqual([[2, "DROP TABLE"], [3, "DROP COLUMN"], [4, "RENAME"], [5, "RENAME"], [6, "DROP COLUMN"]]);
  });
  it("sees through quoted, qualified and single-quoted names, and identifiers that look like comments", () => {
    const sql = [
      'ALTER TABLE main."docs" DROP COLUMN data;',
      'ALTER TABLE "main"."docs" RENAME TO archived_docs;',
      "ALTER TABLE 'docs' DROP COLUMN data;",
      'ALTER TABLE [my table] RENAME COLUMN a TO b;',
      'ALTER TABLE `we""ird` DROP x;',
      'CREATE TABLE "x--old" (v TEXT); DROP TABLE docs;',
      'CREATE TABLE "y/*" (v TEXT); DROP TABLE pins; -- */',
      'DROP TABLE"docs"; DROP TABLE[pins];',
      'ALTER TABLE "docs"DROP COLUMN data; ALTER TABLE`a`.`b`RENAME TO c;',
      'ALTER TABLE café DROP COLUMN data; ALTER TABLE docs$old RENAME TO archive;',
    ].join("\n");
    expect(destructive(sql).map((f) => [f.line, f.kind])).toEqual([
      [1, "DROP COLUMN"], [2, "RENAME"], [3, "DROP COLUMN"], [4, "RENAME"], [5, "DROP COLUMN"], [6, "DROP TABLE"], [7, "DROP TABLE"],
      [8, "DROP TABLE"], [8, "DROP TABLE"], [9, "DROP COLUMN"], [9, "RENAME"], [10, "DROP COLUMN"], [10, "RENAME"],
    ]);
  });
  it("leaves additive and index or trigger changes alone, and ignores comments and strings", () => {
    const sql = [
      "-- Rolling back: DROP TABLE pins",
      "/* ALTER TABLE x RENAME TO y */",
      "ALTER TABLE docs ADD COLUMN assignee TEXT;",
      "DROP TRIGGER docs_ai;",
      "DROP INDEX IF EXISTS i;",
      "INSERT INTO notes VALUES ('drop table x; alter table y rename to z');",
      "CREATE TRIGGER t AFTER DELETE ON docs BEGIN DELETE FROM doc_links WHERE id = OLD.id; END;",
    ].join("\n");
    expect(destructive(sql)).toEqual([]);
  });
});

describe("guardProblems", () => {
  it("a destructive file fails, naming the statement; an allow comment with a reason lets it through", () => {
    const bad = "DROP TABLE doc_links;";
    expect(guardProblems("0011_x.sql", bad)).toEqual(["0011_x.sql:1 DROP TABLE: add `-- migration-guard: allow <why>` if this is meant (docs/deploy.md)"]);
    expect(guardProblems("0011_x.sql", "-- migration-guard: allow doc_links is derived from docs\n" + bad)).toEqual([]);
    expect(guardProblems("0011_x.sql", "-- migration-guard: allow\n" + bad)).toHaveLength(1); // a reason is required
    expect(guardProblems("0011_x.sql", "/* migration-guard: allow block comments count too */\n" + bad)).toEqual([]);
  });
  it("the allow marker counts only in a comment, not in data or a name", () => {
    const bad = "DROP TABLE docs;";
    expect(guardProblems("0011_x.sql", "INSERT INTO notes VALUES ('-- migration-guard: allow example');\n" + bad)).toHaveLength(1);
    expect(guardProblems("0011_x.sql", 'CREATE TABLE "-- migration-guard: allow x" (v);\n' + bad)).toHaveLength(1);
  });
});

describe("migrations/", () => {
  it("has no unmarked destructive statement", () => {
    const dir = new URL("../../migrations/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => guardProblems(f, readFileSync(new URL(f, dir), "utf8")))).toEqual([]);
  });
});
