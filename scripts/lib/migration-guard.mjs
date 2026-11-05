// The migration guard (test/shared/migrations.test.ts, so `npm run check`): migrations apply to the live D1 on every
// merge to main, so a statement that destroys data fails the check unless its file says it's meant, in a comment:
// `-- migration-guard: allow <why>`. Destructive here: DROP TABLE, ALTER TABLE … DROP [COLUMN], ALTER TABLE … RENAME.
// Dropping an index or a trigger loses no data and passes. See docs/deploy.md, "Backups and restore".

const ALLOW = /^[\s*]*migration-guard:[ \t]*allow[ \t]+\S/i;
const RULES = [
  ["DROP TABLE", /\bDROP\s+TABLE\b/gi],
  // After ALTER TABLE, one name (quoted ones are a single word by now; unquoted ones may hold any letter or $), maybe
  // schema-qualified.
  ["DROP COLUMN", /\bALTER\s+TABLE\s+[^\s.;(),]+(?:\s*\.\s*[^\s.;(),]+)?\s+DROP\b/giu],
  ["RENAME", /\bALTER\s+TABLE\s+[^\s.;(),]+(?:\s*\.\s*[^\s.;(),]+)?\s+RENAME\b/giu],
];

// SQLite's lexer, as far as the guard needs it: comments (-- to the line's end, /* to */), string literals ('…', ''
// doubled) and quoted identifiers ("…" and `…` with the quote doubled, […]). Returns the SQL with each literal or
// quoted identifier turned into one word (a single-quoted string can name a table too), every
// comment blanked, newlines kept so line numbers hold, and the comments' text.
function lex(sql) {
  let out = "", i = 0;
  const comments = [];
  // Spaced, so a name written against a keyword (DROP TABLE"docs", "docs"DROP) still reads as separate words.
  const word = (s) => " q" + s.slice(1).replace(/[^\n]/g, "_") + " ";
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    let end;
    if (two === "--") {
      end = sql.indexOf("\n", i); if (end < 0) end = sql.length;
      comments.push(sql.slice(i + 2, end)); out += blank(sql.slice(i, end)); i = end; continue;
    }
    if (two === "/*") {
      end = sql.indexOf("*/", i + 2); end = end < 0 ? sql.length : end + 2;
      comments.push(sql.slice(i + 2, end - 2)); out += blank(sql.slice(i, end)); i = end; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      end = i + 1;
      while (end < sql.length) { if (sql[end] === c) { if (sql[end + 1] === c) end += 2; else break; } else end++; }
      end = Math.min(end + 1, sql.length); out += word(sql.slice(i, end)); i = end; continue;
    }
    if (c === "[") {
      end = sql.indexOf("]", i); end = end < 0 ? sql.length : end + 1;
      out += word(sql.slice(i, end)); i = end; continue;
    }
    out += c; i++;
  }
  return { code: out, comments };
}

// Each destructive statement: its kind and the line it starts on, in file order.
export function destructive(sql) {
  const { code } = lex(sql), found = [];
  for (const [kind, re] of RULES) {
    for (const m of code.matchAll(re)) found.push({ kind, index: m.index, line: code.slice(0, m.index).split("\n").length });
  }
  return found.sort((a, b) => a.index - b.index).map(({ kind, line }) => ({ kind, line }));
}

// What fails the check for one migration file. Only a comment can carry the allow marker.
export function guardProblems(file, sql) {
  if (lex(sql).comments.some((c) => ALLOW.test(c))) return [];
  return destructive(sql).map((f) => `${file}:${f.line} ${f.kind}: add \`-- migration-guard: allow <why>\` if this is meant (docs/deploy.md)`);
}
