// Where a detail page's back link (u, Esc) goes, and which list it belongs to. Worked out once, when a navigation
// first arrives at a history entry, and kept on that entry (history.state.nav): the browser's Back and Forward, and a
// reload, come back to the page with the way back it had, not one recomputed from whichever page was left last.
import type { Route, Tab } from "../state.ts";
import { orchHref } from "./items.ts";
import { parseHash } from "./route.ts";

const TABS: readonly Tab[] = ["inbox", "team", "reviews", "history"];
const LABEL: Record<Tab, string> = { inbox: "Inbox", team: "Team", reviews: "Reviews", history: "History" };

// back: the hash it goes up to. ret: the list Back to a list returns to (src/main.ts returnTab) as it stood here.
// tab: the list an item page belongs to (beside it from 700px, current in the nav). from: the hash of the entry before
// this one ("#" for one without a hash, the desktop app at /; null on the session's first page).
export interface Nav { back: string; ret: Tab; tab: Tab; from: string | null }

const isHash = (s: unknown): s is string => typeof s === "string" && /^#[^\s]*$/.test(s);
export function savedNav(state: unknown): Nav | null {
  const n = (state as { nav?: Partial<Nav> } | null)?.nav;
  if (!n || !isHash(n.back) || !TABS.includes(n.ret as Tab) || !TABS.includes(n.tab as Tab) || !(n.from === null || isHash(n.from))) return null;
  return { back: n.back, ret: n.ret as Tab, tab: n.tab as Tab, from: n.from };
}

// `prev`: the page navigated from; `ret`: the list last shown; `kept`: the back link's target now (paging keeps it);
// `rowOpened`: a row clicked in the list beside the item, which starts over.
export function backTarget(r: Route, prev: Route | null, ret: Tab, kept: string | null, rowOpened: boolean): string {
  if (r.view === "run" || r.view === "pr") return "#reviews";
  if (r.view === "item") {
    if (prev && prev.view === "orch") return orchHref(prev.id);
    if (prev && prev.view === "item" && prev.id !== r.id && !rowOpened && kept) return kept;
    // Reviews lists PRs, not items: an item reached from a PR (Decide in Inbox) belongs to the Inbox.
    return "#" + (ret === "reviews" ? "inbox" : ret);
  }
  return "#" + ret;
}

// The list a back target is: an orchestrator page's is Team.
export function listOf(back: string): Tab {
  if (back.startsWith("#orch.")) return "team";
  const t = back.slice(1) as Tab;
  return TABS.includes(t) ? t : "inbox";
}

// On a phone, an item over the Inbox goes back up to the queue ("Queue ⌄", the peek stack's cards above it).
export function backLabel(back: string, view: Route["view"]): string {
  if (back.startsWith("#orch.")) { try { return decodeURIComponent(back.slice(6)); } catch { return back.slice(6); } }
  const t = listOf(back);
  return view === "item" && t === "inbox" ? "Queue" : LABEL[t];
}

// Going up returns to the entry before this one: step back in history rather than add an entry, so Back after it
// leaves the list instead of reopening the page.
// Pages are compared as routes, not hashes: "#/inbox", "#inbox" and no hash at all (the tab last shown) are one page.
export function upIsBack(nav: Nav | null): boolean {
  return !!nav && nav.from !== null && JSON.stringify(parseHash(nav.from)) === JSON.stringify(parseHash(nav.back));
}

// What a new entry knows of the page before it. Arriving by Back or Forward at an entry with no saved way back (made
// before it was kept) the page just left isn't its predecessor, only the one that was left to come back to it: it has
// the defaults of a direct load, and going up from it adds an entry rather than stepping back to a guess.
export function arrival(traversed: boolean, prev: Route | null, kept: string | null, rowOpened: boolean, from: string | null) {
  return traversed ? { prev: null, kept: null, rowOpened: false, from: null } : { prev, kept, rowOpened, from };
}

// Follows a page's back link (a click on it, u, Esc).
export function goUp(a: HTMLAnchorElement): void {
  const nav = savedNav(history.state);
  if (upIsBack(nav) && nav!.back === a.hash) history.back();
  else navigate(a.hash);
}

// The app's own navigations say what they are, for the hashchange they cause (Arrivals.take): a push (a link, a key),
// or a replace (auto-advance after deciding or snoozing, the phone's landing), which carries the replaced entry's
// predecessor, since a replace takes that entry's place in history. Nothing happens when the hash is already there.
let intent: { kind: "push" } | { kind: "replace"; from: string | null } | null = null;
const changes = (hash: string) => { try { return new URL(hash, location.href).hash !== location.hash; } catch { return false; } };
export function navigate(hash: string): void {
  if (changes(hash)) intent = { kind: "push" };
  location.hash = hash;
}
export function replaceWith(hash: string): void {
  if (changes(hash)) intent = { kind: "replace", from: savedNav(history.state)?.from ?? null };
  location.replace(hash);
}

export interface Arrival { traversed: boolean; replacedFrom: string | null | undefined }
// How the hashchange being handled arrived. traversed: a Back or Forward (popstate fires for a link's too, so it can't
// tell). The Navigation API says so before the hashchange; without it (older Safari), a change the app didn't start
// (no intent, not a link click) that added no entry is taken for one. replacedFrom: a replace's carried predecessor
// (undefined when it wasn't a replace).
export class Arrivals {
  private traversed = false;
  private api: boolean;
  private length = typeof history === "undefined" ? 0 : history.length;
  constructor() {
    const nav = (globalThis as { navigation?: EventTarget }).navigation;
    nav?.addEventListener("navigate", (ev) => { this.traversed = (ev as Event & { navigationType?: string }).navigationType === "traverse"; });
    this.api = !!nav;
    // A link the page follows itself (no handler took the click): a push. Bubbling to window, after the page's own
    // handlers, so a click turned into history.back() (goUp) isn't one.
    if (typeof window !== "undefined") window.addEventListener("click", (ev) => {
      // A modified or middle click opens another tab or window, leaving this page where it is.
      if (ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      const a = (ev.target as Element | null)?.closest?.("a[href^='#']") as HTMLAnchorElement | null;
      if (a && !a.target && changes(a.getAttribute("href")!)) intent = { kind: "push" };
    });
  }
  take(): Arrival {
    const i = intent; intent = null;
    const grew = history.length > this.length;
    this.length = history.length;
    let traversed: boolean;
    if (this.api) { traversed = this.traversed; this.traversed = false; } else traversed = !i && !grew;
    return { traversed, replacedFrom: !traversed && i?.kind === "replace" ? i.from : undefined };
  }
}
