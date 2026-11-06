// Live updates apply GET /api/state/delta to the /api/state the page holds instead of refetching the whole
// snapshot (docs/api.md, "State delta": the merge contract). Pure, so test/worker/delta.test.ts checks this very
// function against the real server: a snapshot with every delta since applied equals a fresh /api/state.
import type { Doc, Principal, StateDelta, StateDeltaResponse, StateResponse } from "../../shared/types.ts";

// The delta can't be merged (a reset, a cursor going backwards, another identity, a malformed body): the caller
// fetches the full /api/state instead.
export class DeltaMismatch extends Error {}

// Who a snapshot belongs to: a delta (or a saved snapshot) for someone else must never merge into it.
export function identityOf(me: Principal | null | undefined): string {
  if (!me || typeof me !== "object") return "";
  return me.kind === "human" ? "human:" + String(me.email).toLowerCase() : "token:" + me.name;
}

const isDoc = (x: unknown): x is Doc<unknown> => {
  const d = x as Doc<unknown> | null;
  return !!d && typeof d === "object" && typeof d.id === "string" && typeof d.version === "number" && typeof d.created_at === "string";
};
const docList = (x: unknown): x is Doc<unknown>[] => Array.isArray(x) && x.every(isDoc);

function check(s: StateResponse, d: StateDeltaResponse): asserts d is StateDelta {
  if (!d || typeof d !== "object") throw new DeltaMismatch("not a delta");
  if ("reset" in d) throw new DeltaMismatch("reset");
  if (typeof d.cursor !== "number" || !docList(d.items) || !docList(d.orchestrators) || !Array.isArray(d.deleted) || !Array.isArray(d.qa_changed)) {
    throw new DeltaMismatch("malformed delta");
  }
  if (d.cursor < s.cursor) throw new DeltaMismatch(`cursor went back from ${s.cursor} to ${d.cursor}`);
  if (!identityOf(d.me) || identityOf(d.me) !== identityOf(s.me)) throw new DeltaMismatch("delta for another identity");
}

// Drop the deleted ids, then upsert the changed docs. The delta's copy is the current one, but a copy held with a
// higher version of the same doc (same created_at: not deleted and recreated) is newer still: a write's result.
function upsert<T>(held: Doc<T>[], changed: Doc<T>[], gone: Set<string>): Doc<T>[] {
  const byId = new Map(held.map((x) => [x.id, x]));
  for (const id of gone) byId.delete(id);
  for (const x of changed) {
    const cur = byId.get(x.id);
    if (!cur || cur.created_at !== x.created_at || x.version >= cur.version) byId.set(x.id, x);
  }
  return [...byId.values()];
}

// The snapshot with the delta applied (a new object; `s` is left as it was). Archived items it held stay, so its
// archived window only grows until the next full fetch, and `archived_more` keeps its full-fetch value.
export function mergeDelta(s: StateResponse, d: StateDeltaResponse): StateResponse {
  check(s, d);
  const gone = (collection: string) => new Set(d.deleted.filter((x) => x && x.collection === collection).map((x) => x.id));
  const next: StateResponse = {
    ...s,
    items: upsert(s.items, d.items, gone("items")),
    orchestrators: upsert(s.orchestrators, d.orchestrators, gone("orchestrators")),
    cursor: d.cursor,
    me: d.me,
  };
  // Present means replace, null included; absent means unchanged.
  if ("manager" in d) next.manager = d.manager ?? null;
  if ("lease" in d) next.lease = d.lease ?? null;
  if (d.schedule) next.schedule = d.schedule;
  if (d.people) next.people = d.people;
  if (d.snoozes) next.snoozes = d.snoozes;
  if (d.pins) next.pins = d.pins;
  if (typeof d.archived_total === "number") next.archived_total = d.archived_total;
  if (Array.isArray(d.routines)) next.routines = d.routines;
  // Entry by entry: fleets are never deleted, so the ones a delta leaves out are unchanged. A snapshot without the
  // map (from a Worker before it) can't take part of one: refetch.
  if (d.fleets && typeof d.fleets === "object") {
    if (!s.fleets) throw new DeltaMismatch("fleets without a map to merge into");
    next.fleets = { ...s.fleets, ...d.fleets };
  }
  return next;
}

// The item ids a delta removed: a loaded History page may hold one the snapshot doesn't.
export function deletedItems(d: StateDelta): string[] {
  return d.deleted.filter((x) => x && x.collection === "items").map((x) => x.id);
}

// What a sync brought (src/store.ts): a full /api/state, or the held one with a delta merged in, plus the item ids
// it deleted and the items whose qa thread changed.
export type Synced =
  | { full: true; state: StateResponse }
  | { full: false; state: StateResponse; deleted: string[]; qa: string[] };
