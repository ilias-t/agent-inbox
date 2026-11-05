// Archived items page in: /api/state?archived=n holds every open/decided/processing item and only the n most
// recently updated archived ones; History loads older pages from GET /api/items. These merge what a live refetch
// or a page brings with what is already loaded, by id. Paging order is the doc's updated_at, newest first, ties
// by id descending (worker/routes/items.ts), never data.updated_at.
import type { Doc, Item } from "../../shared/types.ts";

export interface Cursor { at: string; id: string }

// True when a sorts strictly after (older than) b in the paging order.
function olderThan(a: Cursor, b: Cursor): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id);
}
const keyOf = (d: Doc<Item>): Cursor => ({ at: d.updated_at, id: d.id });
const isArchived = (d: Doc<Item>) => d.data.status === "archived";

// Where Load older continues from: the oldest archived doc.
export function oldestArchived(docs: Iterable<Doc<Item>>): Cursor | null {
  let oldest: Cursor | null = null;
  for (const d of docs) if (isArchived(d) && (!oldest || olderThan(keyOf(d), oldest))) oldest = keyOf(d);
  return oldest;
}

// A refetch is the truth for what it covers: every non-archived item, and the archived ones newer than its
// oldest archived item. A loaded archived item older than that is kept (paged in earlier, or it slid out of the
// window as newer ones were archived). Anything else it leaves out was deleted. Without `archived_more` (all
// archived items included, or a server from before paging) it covers everything.
export function mergeState(prev: Map<string, Doc<Item>>, s: { items: Doc<Item>[]; archived_more?: boolean }): Map<string, Doc<Item>> {
  const next = new Map(s.items.map((d) => [d.id, d]));
  if (!s.archived_more) return next;
  const edge = oldestArchived(s.items);
  for (const [id, d] of prev) {
    if (!next.has(id) && isArchived(d) && (!edge || olderThan(keyOf(d), edge))) next.set(id, d);
  }
  return next;
}

// True when a refetch's archived window starts above everything loaded: more items were archived meanwhile (say,
// a tab hidden through a busy stretch) than the window holds, so some between the two may be missing, and Load
// older, continuing below the loaded ones, would never reach them. The caller starts over from the window.
export function windowGap(prev: Map<string, Doc<Item>>, s: { items: Doc<Item>[]; archived_more?: boolean }): boolean {
  if (!s.archived_more) return false;
  const edge = oldestArchived(s.items);
  if (!edge) return false;
  let loaded = false;
  for (const d of prev.values()) {
    if (!isArchived(d)) continue;
    if (!olderThan(keyOf(d), edge)) return false; // the window reaches into what was loaded
    loaded = true;
  }
  return loaded;
}

// A page of older items: added, but never over a newer copy a live update already brought.
export function mergePage(prev: Map<string, Doc<Item>>, page: Doc<Item>[]): Map<string, Doc<Item>> {
  const next = new Map(prev);
  for (const d of page) {
    const cur = next.get(d.id);
    if (!cur || d.version > cur.version) next.set(d.id, d);
  }
  return next;
}
