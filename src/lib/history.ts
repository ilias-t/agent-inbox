// History tab: a client-side search over the loaded items, plus quick filters.
import type { ItemRow } from "./items.ts";

export type HistoryFilter = "all" | "mine" | "auto" | "overridden";
export const HISTORY_FILTERS: HistoryFilter[] = ["all", "mine", "auto", "overridden"];
export const HISTORY_FILTER_LABEL: Record<HistoryFilter, string> = { all: "All", mine: "Decided by me", auto: "Auto-decided", overridden: "Overridden" };
export function isHistoryFilter(v: unknown): v is HistoryFilter { return HISTORY_FILTERS.includes(v as HistoryFilter); }

// What a search looks in: title, summary, question, the decision's note, the orchestrator id. Lowercased once
// per item object (a refetch makes new objects, so the cache never goes stale).
const hay = new WeakMap<ItemRow, string>();
function haystack(i: ItemRow): string {
  let h = hay.get(i);
  if (h === undefined) {
    h = [i.title, i.summary, i.question, i.decision?.note, i.orchestrator].filter((s) => typeof s === "string").join("\n").toLowerCase();
    hay.set(i, h);
  }
  return h;
}

function passes(i: ItemRow, f: HistoryFilter, me: string | null): boolean {
  if (f === "mine") return !!me && (i.decision?.by || "").toLowerCase() === "human:" + me.toLowerCase();
  if (f === "auto") return i.type === "auto_decided";
  if (f === "overridden") return i.decision?.choice === "override";
  return true;
}

// Every word of the query must appear somewhere (any order, any case). `me`: the signed-in human's email.
export function filterHistory(items: ItemRow[], query: string, f: HistoryFilter, me: string | null): ItemRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => passes(i, f, me) && words.every((w) => haystack(i).includes(w)));
}

// History's count: decided, processing and archived items, archived ones not loaded yet included (the server's
// `archivedTotal`). No sorting: the tab label shows it even while History is hidden.
export function historyTotal(items: ItemRow[], archivedTotal: number): number {
  let past = 0, archived = 0;
  for (const i of items) {
    if (i.status === "archived") archived++;
    else if (i.status === "decided" || i.status === "processing") past++;
  }
  return past + Math.max(archivedTotal, archived);
}

// Load older: the rows to append when the shown list (`after`, filtered and sorted) is the one already on screen
// (`before`, its ids) plus rows at the end; null when a row sorts in among them or one is gone, so the list rebuilds.
// History sorts by decision time but pages by update time, so a page's row can land above the last one shown.
export function appendedRows(before: string[], after: ItemRow[]): ItemRow[] | null {
  if (after.length < before.length) return null;
  for (let k = 0; k < before.length; k++) if (after[k].id !== before[k]) return null;
  return after.slice(before.length);
}

// The page holds only the most recent archived items until older pages load, so a search of 2+ characters also
// asks the server (GET /api/items?q=) while some archived items aren't loaded.
export const SERVER_SEARCH_MIN = 2;
export function wantsServerSearch(query: string, archivedMore: boolean): boolean {
  return archivedMore && query.trim().length >= SERVER_SEARCH_MIN;
}

// The server's hits that the local list doesn't already have, in the server's order (newest first), under the same
// search and quick filter. `localIds`: every loaded item, so a loaded copy always wins over a hit's.
export function serverMatches(hits: ItemRow[], localIds: Set<string>, query: string, f: HistoryFilter, me: string | null): ItemRow[] {
  const seen = new Set<string>();
  return filterHistory(hits, query, f, me).filter((i) => !localIds.has(i.id) && !seen.has(i.id) && !!seen.add(i.id));
}

// History's rows under day headers (Today, Yesterday, Mon 5 Oct): consecutive rows of the same day, in order, each
// run with its day. `after`: the day of the row already shown above them (Load older appends below it), so a run
// that continues that day gets no header of its own (head false) and no day is headed twice.
export interface DayRun<T> { day: string; head: boolean; rows: T[] }
export function dayRuns<T>(rows: T[], dayOf: (row: T) => string, after: string | null = null): DayRun<T>[] {
  const runs: DayRun<T>[] = [];
  for (const row of rows) {
    const day = dayOf(row), last = runs[runs.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else runs.push({ day, head: !(runs.length === 0 && day === after), rows: [row] });
  }
  return runs;
}
