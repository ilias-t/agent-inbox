// The three layouts the page lays out for, by viewport width. Phone: one pane and a bottom nav. Mid and desk: the
// main nav in the top bar (and, once the split view lands, the list beside the item). CSS uses the same edges:
// (max-width: 699.98px), (min-width: 700px) and (min-width: 1100px).
export type Layout = "phone" | "mid" | "desk";

export const MID_MIN = 700;
export const DESK_MIN = 1100;

// The media queries src/main.ts watches; their `matches` decide the layout, so it never disagrees with the CSS.
export const MID_QUERY = "(min-width: " + MID_MIN + "px)";
export const DESK_QUERY = "(min-width: " + DESK_MIN + "px)";

export function layoutFor(width: number): Layout {
  return width >= DESK_MIN ? "desk" : width >= MID_MIN ? "mid" : "phone";
}

// The layout two media query results describe: `mid` for MID_QUERY, `desk` for DESK_QUERY.
export function layoutOf(mid: boolean, desk: boolean): Layout {
  return desk ? "desk" : mid ? "mid" : "phone";
}

// Mid and desk have room for the list and the item side by side; a phone shows one or the other.
export function isSplit(l: Layout): boolean {
  return l !== "phone";
}
