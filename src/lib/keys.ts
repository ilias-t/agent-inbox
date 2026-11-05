// Keyboard shortcuts as a pure mapping from a key event to an action; src/views/keys.ts performs them.

// "orch": an orchestrator, run or PR page beside its list (from 700px); "other": one alone (a phone) or Settings.
export type KeyView = "index" | "item" | "orch" | "other";
export type KeyAction =
  | { type: "help" }
  | { type: "blur" }                          // Esc inside a text field
  | { type: "g" }                             // first half of g i / g t / g r / g h / g s
  | { type: "go"; to: "inbox" | "team" | "reviews" | "history" | "settings" }
  | { type: "next" } | { type: "prev" }       // item page: next / previous item; a page beside its list: the row below / above
  | { type: "back" }                          // detail pages: back to the list
  | { type: "choose"; n: number }             // item page: option n (1-based)
  | { type: "submit" }                        // item page: submit the decision, or send the open text field
  | { type: "ask" } | { type: "accept" } | { type: "override" }
  | { type: "note" }                          // item page: the decision's note (opened if it's folded away)
  | { type: "snooze" }                        // item page: open the snooze menu
  | { type: "pin" }                           // pin or unpin the item, orchestrator or PR open, or the focused row
  | { type: "search" }                        // index: focus the History search
  | { type: "toggle" }                        // Reviews: Runs or PRs (the list, or a pane beside it)
  | { type: "rowNext" } | { type: "rowPrev" }; // index: move between rows (Enter opens)

export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean; repeat?: boolean }
export interface KeyContext {
  view: KeyView;
  typing: boolean;   // focus is in an input, textarea, select or contenteditable
  sendField?: boolean; // that field is one Ctrl/⌘+Enter sends from: the decision's note or the question box
  onChoice: boolean; // focus is on the checked option button (Enter submits it; on any other option Enter picks it)
  pendingG: boolean; // the previous key was a lone "g"
  settling: boolean; // this item page was just arrived at (see settling())
}

const GO: Record<string, "inbox" | "team" | "reviews" | "history" | "settings"> = { i: "inbox", t: "team", r: "reviews", h: "history", s: "settings" };

// A held key repeats moves only; it never re-submits, re-picks or acts on the item auto-advanced to.
const REPEATS = new Set(["next", "prev", "rowNext", "rowPrev", "blur"]);
// Nor does a quick second press: right after arriving at an item (an auto-advance, a row, prev/next, a push tap) the
// decision keys wait a moment, so "y y" accepts one FYI item instead of archiving the next one unseen. Moves stay live.
const DECIDES = new Set(["choose", "submit", "accept", "override", "snooze"]);
export const SETTLE_MS = 400;
export const settling = (advancedAt: number, now: number) => now - advancedAt < SETTLE_MS;

export function keyAction(ev: KeyLike, ctx: KeyContext): KeyAction | null {
  const a = mapKey(ev, ctx);
  if (a && ctx.settling && DECIDES.has(a.type)) return null;
  return a && ev.repeat && !REPEATS.has(a.type) ? null : a;
}

function mapKey(ev: KeyLike, ctx: KeyContext): KeyAction | null {
  if (ev.isComposing) return null;
  const mod = !!(ev.ctrlKey || ev.metaKey), k = ev.key;
  // Typing: only the explicit send chord (from the note or the question box, not from any other field) and Esc;
  // every plain key belongs to the field.
  if (ctx.typing) {
    if (mod && !ev.altKey && k === "Enter" && ctx.view === "item" && ctx.sendField) return { type: "submit" };
    if (k === "Escape") return { type: "blur" };
    return null;
  }
  if (mod || ev.altKey) return mod && !ev.altKey && k === "Enter" && ctx.view === "item" ? { type: "submit" } : null;
  if (ctx.pendingG) {
    const to = GO[k.toLowerCase()];
    if (to) return { type: "go", to };
  }
  if (k === "?") return { type: "help" };
  if (k === "g") return { type: "g" };
  // j / k (and ↓ / ↑) are down / up everywhere: the next and previous item, row or page in the list's order.
  if (ctx.view === "item") {
    if (k === "j" || k === "ArrowDown") return { type: "next" };
    if (k === "k" || k === "ArrowUp") return { type: "prev" };
    if (k === "Escape" || k === "u") return { type: "back" };
    if (/^[1-9]$/.test(k)) return { type: "choose", n: Number(k) };
    if (k === "Enter") return ctx.onChoice ? { type: "submit" } : null;
    if (k === "a") return { type: "ask" };
    if (k === "n") return { type: "note" };
    if (k === "y") return { type: "accept" };
    if (k === "o") return { type: "override" };
    if (k === "s") return { type: "snooze" };
    if (k === "p") return { type: "pin" };
    return null;
  }
  // Every other view: the page open (an orchestrator or a PR), or the list's focused row.
  if (k === "p") return { type: "pin" };
  if (ctx.view === "orch") {
    if (k === "j" || k === "ArrowDown") return { type: "next" };
    if (k === "k" || k === "ArrowUp") return { type: "prev" };
    if (k === "v") return { type: "toggle" };
  }
  if (ctx.view === "index") {
    if (k === "j" || k === "ArrowDown") return { type: "rowNext" };
    if (k === "k" || k === "ArrowUp") return { type: "rowPrev" };
    if (k === "/") return { type: "search" };
    if (k === "v") return { type: "toggle" };
    return null;
  }
  if (k === "Escape" || k === "u") return { type: "back" };
  return null;
}

// The help overlay's rows, kept next to the bindings above. Keys: "|" separates alternatives,
// "+" joins a chord, a space is a sequence ("g i"). A third entry is the row's short label in the desk's hint bar
// under the item (keyHints).
export const SHORTCUTS: { group: string; rows: [keys: string, what: string, hint?: string][] }[] = [
  { group: "Item page", rows: [
    ["j|↓", "Next item", "Next"],
    ["k|↑", "Previous item", "Previous"],
    ["1–9", "Choose an option (the last one is Other…)", "Choose"],
    ["Enter", "Submit the chosen option"],
    ["Ctrl+Enter|⌘+Enter", "Submit, or send from a text field", "Submit"],
    ["n", "Add a note to your decision", "Note"],
    ["a", "Ask a question", "Ask"],
    ["y", "FYI item: looks good", "Looks good"],
    ["o", "FYI item: override…", "Override"],
    ["s", "Snooze…", "Snooze"],
    ["p", "Pin to the top of its list, or unpin", "Pin"],
    ["u|Esc", "Back to the list", "Back"],
  ] },
  { group: "Inbox", rows: [
    ["j|↓", "Next row"],
    ["k|↑", "Previous row"],
    ["Enter", "Open the row"],
    ["p", "Pin or unpin the row, or the manager or PR open"],
    ["/", "Search History"],
    ["v", "Reviews: Runs or PRs"],
  ] },
  { group: "Anywhere", rows: [
    ["g i", "Go to Inbox"],
    ["g t", "Go to Team"],
    ["g r", "Go to Reviews"],
    ["g h", "Go to History"],
    ["g s", "Go to Settings"],
    ["?", "Show or hide this list"],
    ["Esc", "Leave a text field"],
  ] },
];

// What the item on screen takes keys for: an open decision (choose, submit), an FYI item (looks good, override), a
// closed one, or anything a viewer looks at (moves only).
export type HintKind = "decide" | "auto" | "closed" | "view";
const HINT_KINDS: Partial<Record<KeyAction["type"], HintKind[]>> = {
  choose: ["decide"], submit: ["decide"], note: ["decide"], accept: ["auto"], override: ["auto"], snooze: ["decide", "auto"], ask: ["decide", "auto", "closed"],
};
// A row's first key as an event: "1–9" is 1, "Ctrl+Enter" is Enter with Ctrl held.
function firstKey(spec: string): KeyLike {
  const parts = spec.split("|")[0].replace(/–\d$/, "").split("+"), key = parts[parts.length - 1];
  return { key, ctrlKey: parts.includes("Ctrl"), metaKey: parts.includes("⌘") };
}
// The desk's hint bar (src/views/item.ts, from 1100px): the item page's rows that have a short label and do something
// on this kind of item, in order, each with its keys (alternatives apart, Enter as ↵; Ctrl+Enter and ⌘+Enter as one
// "Ctrl/⌘+↵"). What a row does is what mapKey makes of its first key with focus on no particular control (Enter alone
// submits only from the checked option, so the bar shows the chord), and the bar can't drift from the bindings.
// snooze: false for a token's session (it can't snooze or pin). The bar ends with "? All keys".
export function keyHints(kind: HintKind = "decide", snooze = true): { keys: string[]; label: string }[] {
  const g = SHORTCUTS.find((x) => x.group === "Item page");
  return (g ? g.rows : []).flatMap(([k, , hint]) => {
    const a = hint ? mapKey(firstKey(k), { view: "item", typing: false, onChoice: false, pendingG: false, settling: false }) : null;
    if (!hint || !a || !(HINT_KINDS[a.type] ?? [kind]).includes(kind) || ((a.type === "snooze" || a.type === "pin") && !snooze)) return [];
    const alts = k.split("|").map((x) => x.replace(/Enter$/, "↵"));
    return [{ keys: alts.length === 2 && alts[0] === "Ctrl+↵" && alts[1] === "⌘+↵" ? ["Ctrl/⌘+↵"] : alts, label: hint }];
  });
}
