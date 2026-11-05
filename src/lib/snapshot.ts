// The last good /api/state (deltas merged in), saved in IndexedDB so the next open renders it at once and then
// revalidates with a delta from its cursor (src/main.ts boot). Storage is a convenience: anything that throws,
// refuses (private mode, blocked site data) or never answers just means no snapshot.
import type { Doc, Item, StateResponse } from "../../shared/types.ts";

// Archived items beyond the newest this many aren't saved: History pages them in again (as /api/state?archived=100).
export const SNAPSHOT_ARCHIVED = 100;
// Older than this, the snapshot shown at boot is marked as a saved copy until it's revalidated.
export const STALE_MS = 10 * 60 * 1000;

export interface Snapshot {
  v: 1;
  savedAt: number; // ms
  state: StateResponse;
}

const DB = "agent-inbox", STORE = "snapshot", KEY = "state", TIMEOUT_MS = 2000;

// Newest first, ties by id descending: the server's paging order (worker/routes/items.ts).
const newestFirst = (a: Doc<Item>, b: Doc<Item>) =>
  a.updated_at !== b.updated_at ? (a.updated_at < b.updated_at ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

// Every item that isn't archived, and the newest SNAPSHOT_ARCHIVED archived ones; `archived_more` when any were
// left out, so Load older continues below the ones kept.
export function capSnapshot(s: StateResponse, n = SNAPSHOT_ARCHIVED): StateResponse {
  const archived = s.items.filter((d) => d.data.status === "archived");
  if (archived.length <= n) return s;
  const keep = new Set(archived.sort(newestFirst).slice(0, n));
  return { ...s, items: s.items.filter((d) => d.data.status !== "archived" || keep.has(d)), archived_more: true };
}

export function toSnapshot(s: StateResponse, now: number): Snapshot {
  return { v: 1, savedAt: now, state: capSnapshot(s) };
}

export function isStale(savedAt: number, now: number): boolean {
  return now - savedAt > STALE_MS;
}

function valid(x: unknown): x is Snapshot {
  const s = x as Snapshot | null;
  return !!s && s.v === 1 && typeof s.savedAt === "number" && !!s.state && typeof s.state.cursor === "number"
    && Array.isArray(s.state.items) && Array.isArray(s.state.orchestrators) && !!s.state.me;
}

// Settles with the request's result, or null when it fails, throws or doesn't answer in time.
function settle<T>(start: () => IDBRequest<T> | IDBOpenDBRequest, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const done = (v: T | null) => { clearTimeout(timer); resolve(v); };
    try {
      const req = start();
      req.onsuccess = () => done(req.result as T);
      req.onerror = () => done(null);
    } catch {
      done(null);
    }
  });
}

function open(ms: number): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined" || !indexedDB) return Promise.resolve(null);
  return settle<IDBDatabase>(() => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onblocked = () => { /* another tab holds an older version: the timeout gives up */ };
    return req;
  }, ms);
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, ms = TIMEOUT_MS): Promise<T | null> {
  const db = await open(ms);
  if (!db) return null;
  try {
    return await settle<T>(() => fn(db.transaction(STORE, mode).objectStore(STORE)), ms);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

// `ms`: how long boot waits for it before going to the network without one.
export async function readSnapshot(ms = TIMEOUT_MS): Promise<Snapshot | null> {
  const s = await withStore<unknown>("readonly", (st) => st.get(KEY), ms);
  return valid(s) ? s : null;
}

export async function saveSnapshot(s: Snapshot): Promise<void> {
  await withStore("readwrite", (st) => st.put(s, KEY));
}

export async function clearSnapshot(): Promise<void> {
  await withStore("readwrite", (st) => st.delete(KEY));
}
