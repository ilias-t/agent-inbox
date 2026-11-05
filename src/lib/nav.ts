import type { Pins } from "../../shared/types.ts";
import { fyiItems, openItems, type ItemRow } from "./items.ts";
import { pinInbox } from "./pins.ts";

// Triage order: the inbox index's own display order, the viewer's pinned asks and FYI items first (`pins`, as
// src/lib/pins.ts pinInbox shows them), then the asks (priority groups), then the FYI group. Snoozed items are out of
// it until they wake.
export function triageOrder(items: ItemRow[], now = Date.now(), pins: Pins = {}): string[] {
  const g = pinInbox(openItems(items, now), fyiItems(items, now), pins);
  return g.pinned.concat(g.asks, g.fyi).map((i) => i.id);
}

export interface Neighbors { prev: string | null; next: string | null; index: number; total: number }

// Prev/next for an item page. An item that is no longer in the queue (decided, opened from History)
// keeps its place in `remembered`, the order last seen while it was open; failing that, next is the
// first open item. index is 0-based and -1 when the item isn't in the queue.
export function neighbors(items: ItemRow[], id: string, remembered: string[] = [], now = Date.now(), pins: Pins = {}): Neighbors {
  const order = triageOrder(items, now, pins), total = order.length, i = order.indexOf(id);
  if (i >= 0) return { prev: order[i - 1] ?? null, next: order[i + 1] ?? null, index: i, total };
  const live = new Set(order), j = remembered.indexOf(id);
  if (j < 0) return { prev: null, next: order[0] ?? null, index: -1, total };
  const before = remembered.slice(0, j).reverse().find((x) => live.has(x)) ?? null;
  const after = remembered.slice(j + 1).find((x) => live.has(x)) ?? null;
  return { prev: before, next: after, index: -1, total };
}

// j/k on an index list: the row `step` away from the cursor row `at`, clamped to the list's ends.
// With no cursor, or one whose row has left the list, both keys start at the top row.
export function stepRow(rows: string[], at: string | null, step: 1 | -1): string | null {
  if (!rows.length) return null;
  const i = at == null ? -1 : rows.indexOf(at);
  return i < 0 ? rows[0] : rows[Math.min(rows.length - 1, Math.max(0, i + step))];
}

// Where to go after deciding (or snoozing) `id`: the first item after it in `orderBefore` (the queue as it
// stood when the write was sent) that is still in the queue now. null means back to the inbox, even
// when skipped items above it are still open: the inbox then shows what's left.
export function advanceTarget(orderBefore: string[], id: string, itemsAfter: ItemRow[], now = Date.now(), pins: Pins = {}): string | null {
  const live = new Set(triageOrder(itemsAfter, now, pins)), i = orderBefore.indexOf(id);
  if (i < 0) return null;
  return orderBefore.slice(i + 1).find((x) => x !== id && live.has(x)) ?? null;
}
