// Pins (PUT /api/pins/<kind>/<ref>, docs/api.md "Pins"): the signed-in human keeps an item, an orchestrator or a
// Reviews PR at the top of its own list, in a Pinned group. Per person, like snoozes: /api/state's `pins` are the
// viewer's own, "<kind>:<ref>" → when it was pinned. A PR's ref is "<routine>/<n>".
import type { PinKind, Pins, ReviewPrRow } from "../../shared/types.ts";
import type { ItemRow } from "./items.ts";
import { parseReviewHash } from "./reviews.ts";

export const pinKey = (kind: PinKind, ref: string): string => kind + ":" + ref;
export const isPinned = (pins: Pins, key: string): boolean => Object.hasOwn(pins, key);

// Keys newest pin first; the same time goes by key, so the order never flickers.
export function byPin(pins: Pins, keys: string[]): string[] {
  return [...keys].sort((a, b) => (pins[a] !== pins[b] ? (pins[a] < pins[b] ? 1 : -1) : a < b ? -1 : a > b ? 1 : 0));
}

// A list's rows split into its Pinned group (newest pin first) and the rest, in the order they came.
export function splitPinned<T>(rows: T[], keyOf: (row: T) => string, pins: Pins): { pinned: T[]; rest: T[] } {
  if (!Object.keys(pins).length) return { pinned: [], rest: rows };
  const pinned: T[] = [], rest: T[] = [];
  for (const r of rows) (isPinned(pins, keyOf(r)) ? pinned : rest).push(r);
  const order = byPin(pins, pinned.map(keyOf));
  pinned.sort((a, b) => order.indexOf(keyOf(a)) - order.indexOf(keyOf(b)));
  return { pinned, rest };
}

// One kind's pinned refs, newest pin first.
export function pinnedRefs(pins: Pins, kind: PinKind): string[] {
  const pre = kind + ":";
  return byPin(pins, Object.keys(pins).filter((k) => k.startsWith(pre))).map((k) => k.slice(pre.length));
}

const itemKey = (i: { id: string }) => pinKey("item", i.id);

// The Inbox: pinned asks and FYI items (snoozed ones stay snoozed) go in Pinned, out of their own groups.
export function pinInbox(asks: ItemRow[], fyi: ItemRow[], pins: Pins): { pinned: ItemRow[]; asks: ItemRow[]; fyi: ItemRow[] } {
  const { pinned } = splitPinned(asks.concat(fyi), itemKey, pins);
  const out = (x: ItemRow) => !isPinned(pins, itemKey(x));
  return { pinned, asks: asks.filter(out), fyi: fyi.filter(out) };
}

// History: the past items it shows, plus pinned ones fetched on their own (archived beyond the window the page holds),
// each once. The pinned ones go in Pinned, the rest stay under their days.
export function pinHistory(shown: ItemRow[], fetched: ItemRow[], pins: Pins): { pinned: ItemRow[]; rest: ItemRow[] } {
  const ids = new Set(shown.map((i) => i.id));
  const { pinned } = splitPinned(shown.concat(fetched.filter((i) => !ids.has(i.id) && !!ids.add(i.id))), itemKey, pins);
  return { pinned, rest: shown.filter((i) => !isPinned(pins, itemKey(i))) };
}

// Reviews' PRs view, for the routine shown: its pinned PRs (gone ones too) go in Pinned; `missing` are the numbers
// pinned that the list doesn't hold (gone longer than the tab keeps them), fetched on their own.
export function pinPrs(rows: ReviewPrRow[], routine: string, pins: Pins): { pinned: ReviewPrRow[]; rest: ReviewPrRow[]; missing: number[] } {
  const key = (r: ReviewPrRow) => pinKey("pr", routine + "/" + r.number);
  const { pinned, rest } = splitPinned(rows, key, pins);
  const have = new Set(rows.map((r) => r.number)), pre = routine + "/";
  const missing = pinnedRefs(pins, "pr").filter((ref) => ref.startsWith(pre) && /^\d+$/.test(ref.slice(pre.length)))
    .map((ref) => Number(ref.slice(pre.length))).filter((n) => !have.has(n));
  return { pinned, rest, missing };
}

// What a list row's link (or a page's route) pins: #item.<id>, #orch.<id>, #pr[.<routine>].<n> (no routine: the one
// shown, `routine`). null for anything else, a run included.
export function pinOfHref(href: string, routine: string | null): string | null {
  let h = href.replace(/^#/, "");
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  let m: RegExpMatchArray | null;
  if ((m = h.match(/^\/?item[./](.+)$/))) return pinKey("item", m[1]);
  if ((m = h.match(/^\/?orch[./](.+)$/))) return pinKey("orch", m[1]);
  const r = parseReviewHash(h);
  if (r && r.view === "pr") { const rt = r.routine ?? routine; return rt ? pinKey("pr", rt + "/" + r.n) : null; }
  return null;
}
