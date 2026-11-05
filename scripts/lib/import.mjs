// Artifact export → SQL for the docs table. Pure functions (plus one
// directory reader) so scripts/import-artifact.mjs and the tests share them.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isValidCollection, isValidId } from "./ids.mjs";
import { sqlJson, sqlString, sqlValue } from "./sql.mjs";

// Mirrors DEFAULT_SCHEDULE in shared/types.ts (kept in sync by hand; the
// scripts are plain Node and don't load TypeScript).
export const DEFAULT_SCHEDULE = {
  work_hours: "10:00-18:00 Mon-Fri",
  timezone: "America/New_York",
  pickup_interval_min: 10,
  sweep_interval_min: 30,
};

export const IMPORT_ACTOR = "import:artifact";

const WRAPPER_KEYS = new Set([
  "id",
  "doc_id",
  "collection",
  "version",
  "data",
  "created_at",
  "updated_at",
  "updated_by",
]);
const COLLECTION_ORDER = ["meta", "orchestrators", "items"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// One exported document → {id, data, version}. Accepts the wrapped form
// `{id, version, data}` and a flat document (fields at the top level).
function unwrap(entry, fallbackId) {
  if (!isPlainObject(entry)) return { id: fallbackId, data: entry, version: undefined };
  const id = entry.id ?? entry.doc_id ?? fallbackId;
  if (isPlainObject(entry.data) && Object.keys(entry).every((k) => WRAPPER_KEYS.has(k))) {
    return { id, data: entry.data, version: entry.version, created_at: entry.created_at, updated_at: entry.updated_at };
  }
  const { id: _id, doc_id: _docId, collection: _c, version, ...data } = entry;
  return { id, data, version };
}

function entriesOf(collection, value) {
  if (Array.isArray(value)) return value.map((e) => ({ collection, ...unwrap(e, undefined) }));
  if (isPlainObject(value)) {
    return Object.entries(value).map(([key, e]) => ({ collection, ...unwrap(e, key) }));
  }
  return [{ collection, id: undefined, data: value, version: undefined, bad: "collection is not an array or object" }];
}

// Any supported export shape → [{collection, id, data, version}].
//   {items: [...], orchestrators: [...], meta: [...], "items/<id>/qa": [...]}
//   {collections: { ...same... }}
//   [{collection, id, data, version}, ...]
// A collection may also be an object keyed by doc id.
export function normalizeExport(input) {
  if (Array.isArray(input)) {
    return input.map((e) => {
      const collection = isPlainObject(e) ? e.collection : undefined;
      return { collection, ...unwrap(e, undefined) };
    });
  }
  if (!isPlainObject(input)) throw new Error("export must be a JSON object or array");
  const root = isPlainObject(input.collections) ? input.collections : input;
  return Object.entries(root).flatMap(([collection, value]) => entriesOf(collection, value));
}

// A directory written by `ArtifactData ... out_dir`: <dir>/<collection path>/<doc_id>.json.
export function readExportDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        const rel = relative(dir, p).split(sep);
        const id = rel.pop().slice(0, -".json".length);
        const doc = JSON.parse(readFileSync(p, "utf8"));
        out.push({ collection: rel.join("/"), ...unwrap(doc, id) });
      }
    }
  };
  walk(dir);
  return out;
}

const timestamp = (v, now) => (typeof v === "string" && v.length > 0 ? v : now);

function collectionRank(c) {
  const i = COLLECTION_ORDER.indexOf(c);
  return i === -1 ? COLLECTION_ORDER.length : i;
}

// Schedule from meta/manager's legacy mirror fields, or null when it has none.
export function scheduleFromManager(manager) {
  if (!isPlainObject(manager)) return null;
  const keys = ["work_hours", "timezone", "pickup_interval_min", "sweep_interval_min"];
  if (!keys.some((k) => manager[k] !== undefined && manager[k] !== null)) return null;
  const schedule = { ...DEFAULT_SCHEDULE };
  for (const k of keys) if (manager[k] !== undefined && manager[k] !== null) schedule[k] = manager[k];
  return schedule;
}

// Docs → SQL. Returns {sql, statements, docs, counts, skipped, derived}.
//   replace:   upsert (default: INSERT ... ON CONFLICT DO NOTHING, existing docs win)
//   withLease: also import meta/lease (skipped by default: a stale lease from the
//              artifact would only confuse the next manager)
export function buildImportSql(entries, { replace = false, withLease = false, now = new Date().toISOString() } = {}) {
  const skipped = [];
  const derived = [];
  const byKey = new Map();
  for (const e of entries) {
    const where = { collection: e.collection, id: e.id };
    if (e.bad) skipped.push({ ...where, reason: e.bad });
    else if (typeof e.collection !== "string" || !isValidCollection(e.collection))
      skipped.push({ ...where, reason: "invalid collection" });
    else if (!isValidId(e.id)) skipped.push({ ...where, reason: "invalid id" });
    else if (!isPlainObject(e.data)) skipped.push({ ...where, reason: "data is not an object" });
    else if (e.collection === "meta" && e.id === "lease" && !withLease)
      skipped.push({ ...where, reason: "lease not imported (pass --with-lease)" });
    else {
      const key = `${e.collection}\u0000${e.id}`;
      if (byKey.has(key)) skipped.push({ ...where, reason: "duplicate (last one wins)" });
      byKey.set(key, e);
    }
  }

  if (!byKey.has("meta\u0000schedule")) {
    const schedule = scheduleFromManager(byKey.get("meta\u0000manager")?.data);
    if (schedule) {
      byKey.set("meta\u0000schedule", { collection: "meta", id: "schedule", data: schedule, version: 1 });
      derived.push({ collection: "meta", id: "schedule", from: "meta/manager" });
    }
  }

  const docs = [...byKey.values()]
    .map((e) => {
      const data = e.collection === "orchestrators" ? { ...e.data, id: e.id } : e.data;
      return {
        collection: e.collection,
        id: e.id,
        data,
        version: Number.isInteger(e.version) && e.version > 0 ? e.version : 1,
        created_at: timestamp(data.created_at ?? e.created_at, now),
        updated_at: timestamp(data.updated_at ?? e.updated_at ?? data.created_at ?? e.created_at, now),
      };
    })
    .sort(
      (a, b) =>
        collectionRank(a.collection) - collectionRank(b.collection) ||
        a.collection.localeCompare(b.collection) ||
        a.id.localeCompare(b.id),
    );

  const conflict = replace
    ? "ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, version = excluded.version, " +
      "created_at = excluded.created_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
    : "ON CONFLICT (collection, id) DO NOTHING";
  const statements = docs.map(
    (d) =>
      "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES (" +
      [sqlString(d.collection), sqlString(d.id), sqlJson(d.data), sqlValue(d.version), sqlString(d.created_at),
        sqlString(d.updated_at), sqlString(IMPORT_ACTOR)].join(", ") +
      `) ${conflict};`,
  );

  const counts = {};
  for (const d of docs) {
    const k = d.collection.startsWith("items/") ? "items/*/qa" : d.collection;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { sql: statements.join("\n") + (statements.length ? "\n" : ""), statements, docs, counts, skipped, derived };
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Moves every ISO timestamp in a JSON value by deltaMs (the seed uses it to
// make fixture data look recent while keeping its relative order).
export function shiftTimestamps(value, deltaMs) {
  if (typeof value === "string" && ISO_RE.test(value)) {
    return new Date(Date.parse(value) + deltaMs).toISOString();
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimestamps(v, deltaMs));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimestamps(v, deltaMs)]));
  }
  return value;
}
