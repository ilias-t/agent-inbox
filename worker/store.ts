// The generic document store over D1's `docs` table. Every write is pinned:
// an update carries `WHERE version = ?` and a create is insert-if-absent, so
// the check and the write are one statement. Callers that read-modify-write
// without a client pin retry on a lost race instead of overwriting it.

import type { Doc } from "../shared/types.ts";
import { atIndex, badRequest, conflict, UNSAFE_KEYS } from "./http.ts";

export interface DocRow {
  collection: string;
  id: string;
  data: string;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export const COLS = "collection, id, data, version, created_at, updated_at, updated_by";

export function toDoc<T>(row: DocRow): Doc<T> {
  return {
    id: row.id,
    version: row.version,
    data: JSON.parse(row.data) as T,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

export async function getDoc<T = Record<string, unknown>>(
  db: D1Database,
  collection: string,
  id: string,
): Promise<Doc<T> | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM docs WHERE collection = ? AND id = ?`)
    .bind(collection, id)
    .first<DocRow>();
  return row ? toDoc<T>(row) : null;
}

// `where` is appended after the collection filter; binds follow the collection.
export async function listDocs<T = Record<string, unknown>>(
  db: D1Database,
  collection: string,
  where = "",
  binds: unknown[] = [],
  order = "created_at, id",
  limit?: number,
): Promise<Doc<T>[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM docs WHERE collection = ? ${where} ORDER BY ${order}${limit === undefined ? "" : " LIMIT ?"}`)
    .bind(collection, ...binds, ...(limit === undefined ? [] : [limit]))
    .all<DocRow>();
  return results.map((r) => toDoc<T>(r));
}

export function insertStmt(db: D1Database, collection: string, id: string, data: unknown, actor: string, now: string) {
  return db
    .prepare(
      `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING ${COLS}`,
    )
    .bind(collection, id, JSON.stringify(data), now, now, actor);
}

// Pinned on the version read and on the doc's created_at, so a doc deleted and created again under the same id
// (which starts over at version 1) is never written as if it were the one that was read.
function updateStmt(
  db: D1Database,
  collection: string,
  id: string,
  data: unknown,
  actor: string,
  now: string,
  cur: { version: number; created_at: string },
) {
  return db
    .prepare(
      `UPDATE docs SET data = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE collection = ? AND id = ? AND version = ? AND created_at = ? RETURNING ${COLS}`,
    )
    .bind(JSON.stringify(data), now, actor, collection, id, cur.version, cur.created_at);
}

export interface WriteOpts {
  actor: string;
  now: string;
  ifVersion?: number; // client pin; 0 = must not exist
  // Throws (403) when the caller may not see the doc as it is now. It runs on every doc read before anything
  // else, so a 409 never hands a caller (a token, in another fleet) a doc it can't read as `current`.
  authorize?: (cur: Doc<any>) => void;
  // Statements to run in the same transaction after the doc write. They run
  // even when the pin fails, so each must guard itself on the write having
  // landed (see landedClause, which only works for the first one).
  extra?: (next: { version: number }) => D1PreparedStatement[];
}

// The guard for the first `extra` statement: true only when the doc write
// just before it in the batch changed a row. changes() alone decides it; the
// EXISTS can't, since a concurrent write by the same actor in the same
// millisecond (workerd freezes Date.now() between I/O) leaves an identical
// version/updated_at/updated_by. It stays as a backstop that the row is ours.
export const landedClause =
  "changes() = 1 AND EXISTS (SELECT 1 FROM docs WHERE collection = ? AND id = ? AND version = ? AND updated_at = ? AND updated_by = ?)";

const RETRIES = 5;

// Read-modify-write one doc. `build` gets the current doc (null if missing)
// and returns the new data, or throws (404, 403, 409 not_open, ...). With a
// client pin a lost race is a 409 `conflict`; without one it re-reads and
// rebuilds, so concurrent writers never silently overwrite each other.
export async function mutate<T>(
  db: D1Database,
  collection: string,
  id: string,
  opts: WriteOpts,
  build: (cur: Doc<T> | null) => T | Promise<T>,
): Promise<{ doc: Doc<T>; created: boolean }> {
  const seen = (doc: Doc<T> | null) => {
    if (doc) opts.authorize?.(doc);
    return doc;
  };
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const cur = seen(await getDoc<T>(db, collection, id));
    if (opts.ifVersion !== undefined && (cur?.version ?? 0) !== opts.ifVersion) {
      throw conflict("conflict", `Version mismatch: have ${cur?.version ?? 0}, if_version ${opts.ifVersion}`, cur);
    }
    const data = await build(cur);
    const write = cur
      ? updateStmt(db, collection, id, data, opts.actor, opts.now, cur)
      : insertStmt(db, collection, id, data, opts.actor, opts.now);
    let row: DocRow | null;
    if (opts.extra) {
      const [first] = await db.batch<DocRow>([write, ...opts.extra({ version: (cur?.version ?? 0) + 1 })]);
      row = first.results[0] ?? null;
    } else {
      row = await write.first<DocRow>();
    }
    if (row) return { doc: toDoc<T>(row), created: !cur };
    if (opts.ifVersion !== undefined) {
      const now = seen(await getDoc<T>(db, collection, id));
      throw conflict("conflict", "Document changed during the write", now);
    }
  }
  throw conflict("conflict", "Too much contention, retry", seen(await getDoc<T>(db, collection, id)));
}

// One doc write of a mutateMany: mutate's arguments as data.
export interface DocWrite<T = unknown> {
  collection: string;
  id: string;
  ifVersion?: number; // client pin; 0 = must not exist
  build: (cur: Doc<T> | null) => T | Promise<T>;
  extra?: WriteOpts["extra"];
  authorize?: WriteOpts["authorize"];
}

// The docs at these keys, in order (null where missing), in one statement.
async function readDocs(db: D1Database, keys: { collection: string; id: string }[]): Promise<(Doc<unknown> | null)[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM docs WHERE (collection, id) IN
         (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`,
    )
    .bind(JSON.stringify(keys.map((k) => [k.collection, k.id])))
    .all<DocRow>();
  const byKey = new Map(results.map((r) => [`${r.collection}\u0000${r.id}`, r]));
  return keys.map((k) => {
    const row = byKey.get(`${k.collection}\u0000${k.id}`);
    return row ? toDoc(row) : null;
  });
}

// Fails (NOT NULL on docs.collection), and so rolls back the whole batch it
// opens, when any doc's version (0 = absent) or created_at differs from the
// one its write was built on. D1 doesn't roll back a batch for an UPDATE that
// matched no row, so this is what makes the batch all-or-nothing.
const GUARD_SQL = `INSERT INTO docs (collection, id, data, version, created_at, updated_at)
  SELECT NULL, '', '{}', 0, '', '' WHERE EXISTS (
    SELECT 1 FROM json_each(?) AS j
    LEFT JOIN docs AS d ON d.collection = json_extract(j.value, '$[0]') AND d.id = json_extract(j.value, '$[1]')
    WHERE coalesce(d.version, 0) <> json_extract(j.value, '$[2]') OR d.created_at IS NOT json_extract(j.value, '$[3]'))`;

// Several read-modify-writes in one transaction: all land or none do. Each
// write keeps mutate's rules: a client pin that doesn't match is a 409
// `conflict`, `build` may throw, and a write without a pin that loses a race
// is rebuilt from a fresh read (the whole set is, as one). Errors carry the
// failing write's index. Each doc may appear once.
export async function mutateMany(
  db: D1Database,
  writes: DocWrite<any>[],
  opts: { actor: string; now: string },
): Promise<{ doc: Doc<any>; created: boolean }[]> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const curs = await readDocs(db, writes);
    const planned: { cur: Doc<unknown> | null; data: unknown }[] = [];
    for (const [i, w] of writes.entries()) {
      const cur = curs[i];
      try {
        if (cur) w.authorize?.(cur);
        if (w.ifVersion !== undefined && (cur?.version ?? 0) !== w.ifVersion) {
          throw conflict("conflict", `Version mismatch: have ${cur?.version ?? 0}, if_version ${w.ifVersion}`, cur);
        }
        planned.push({ cur, data: await w.build(cur) });
      } catch (e) {
        throw atIndex(e, i);
      }
    }

    const pins = writes.map((w, i) => [w.collection, w.id, curs[i]?.version ?? 0, curs[i]?.created_at ?? null]);
    const stmts: D1PreparedStatement[] = [db.prepare(GUARD_SQL).bind(JSON.stringify(pins))];
    const at: number[] = []; // each write's statement index
    for (const [i, w] of writes.entries()) {
      const { cur, data } = planned[i];
      at.push(stmts.length);
      stmts.push(
        cur
          ? updateStmt(db, w.collection, w.id, data, opts.actor, opts.now, cur)
          : insertStmt(db, w.collection, w.id, data, opts.actor, opts.now),
      );
      // Right after its own write: landedClause reads that write's changes().
      if (w.extra) stmts.push(...w.extra({ version: (cur?.version ?? 0) + 1 }));
    }

    let results: D1Result<DocRow>[];
    try {
      results = await db.batch<DocRow>(stmts);
    } catch (e) {
      // The guard tripped when a doc moved since the read: go again (a moved
      // pinned doc then fails its pin). Anything else is a real error.
      const now = await readDocs(db, writes);
      if (now.every((d, i) => (d?.version ?? 0) === (curs[i]?.version ?? 0) && d?.created_at === curs[i]?.created_at)) throw e;
      continue;
    }
    return writes.map((_, i) => {
      const row = results[at[i]].results[0];
      if (!row) throw new Error(`batch write ${i} returned no row`); // the guard rules this out
      return { doc: toDoc(row), created: !planned[i].cur };
    });
  }
  throw conflict("conflict", "Too much contention, retry", null);
}

// What a delete is pinned on: a version (a client's if_version, or the one a scoped caller read), and with it
// the created_at that was read, so a doc created again under the same id isn't deleted in its place.
export interface DeletePin {
  version?: number;
  createdAt?: string;
}

// The guard a delete's `before` statements share with it: ?N binds the version (or null), ?N+1 the created_at.
export const pinClause = (v: string, ca: string) => `(${v} IS NULL OR version = ${v}) AND (${ca} IS NULL OR created_at = ${ca})`;

// Delete one doc, optionally pinned. `before` runs first in the same
// transaction and must guard itself on the same pin (pinClause), so it only
// acts when the delete will. Returns "missing" when the doc wasn't there.
// `authorize` vets the doc before a 409 hands it back as `current`.
export async function deleteDoc(
  db: D1Database,
  collection: string,
  id: string,
  pin: DeletePin,
  before: D1PreparedStatement[] = [],
  authorize?: (cur: Doc<unknown>) => void,
): Promise<"deleted" | "missing"> {
  const del = db
    .prepare(`DELETE FROM docs WHERE collection = ?1 AND id = ?2 AND ${pinClause("?3", "?4")} RETURNING version`)
    .bind(collection, id, pin.version ?? null, pin.createdAt ?? null);
  const results = await db.batch([...before, del]);
  if (results[results.length - 1].results.length) return "deleted";
  const cur = await getDoc(db, collection, id);
  if (!cur) return "missing";
  authorize?.(cur);
  throw conflict("conflict", `Version mismatch: have ${cur.version}, if_version ${pin.version}`, cur);
}

// Shallow merge where a null value deletes the key (PATCH semantics). Own keys only, and never one that could
// reach a prototype (readJson already refuses them; this holds for any other caller too). Values are defined,
// not assigned, so no setter runs.
export function mergePatch<T extends object>(base: T, patch: Record<string, unknown>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(k)) throw badRequest(`"${k}" can't be a field name`);
    const v = patch[k];
    if (v === null) delete out[k];
    else Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out as T;
}

export async function latestSeq(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM changes").first<{ seq: number }>();
  return r?.seq ?? 0;
}
