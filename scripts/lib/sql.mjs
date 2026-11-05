// SQL literal helpers for the D1 scripts. Values go into files that
// `wrangler d1 execute --file` runs, so everything is inlined as literals.

// A SQLite string literal. Single quotes are doubled; newlines, semicolons
// and `--` are safe inside a literal. NUL can't be stored in TEXT, so reject it.
export function sqlString(value) {
  const s = String(value);
  if (s.includes("\0")) throw new Error("NUL byte in SQL string");
  return `'${s.replaceAll("'", "''")}'`;
}

export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return sqlString(value);
}

// JSON for the docs.data column. JSON.stringify escapes control characters
// (including NUL as \u0000), so only quotes need SQL escaping.
export function sqlJson(value) {
  return sqlString(JSON.stringify(value));
}
