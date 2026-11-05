// Per-page bits of navigation: the document title, and moving focus to a detail page's heading.
import type { Route, Tab } from "../state.ts";

export const APP_NAME = "Agent Inbox";
const TAB_TITLE: Record<Tab, string | null> = { inbox: null, team: "Team", reviews: "Reviews", history: "History" };

export interface TitleInfo {
  need: number;                                   // open asks in the Inbox (its filter applied); 0 hides the prefix
  itemTitle?: string | null;                      // item page: the item's title, null while it isn't loaded
  orch?: { id: string; goal?: string | null } | null; // orchestrator page
  review?: string | null;                         // a run or PR page: its title ("#812 Return 413 …"), null until loaded
}

// "(3) Ship the change log – Agent Inbox". The open count leads on every page so it shows in a background tab.
export function pageTitle(route: Route, info: TitleInfo): string {
  let page: string | null;
  if (route.view === "tab") page = TAB_TITLE[route.tab];
  else if (route.view === "settings") page = "Settings";
  else if (route.view === "item") page = info.itemTitle == null ? null : info.itemTitle.trim() || "(untitled)";
  else if (route.view === "run" || route.view === "pr") page = info.review ? info.review.trim() || null : null;
  else {
    const goal = info.orch && info.orch.goal ? info.orch.goal.trim() : "";
    page = route.id + (goal ? " · " + goal : "");
  }
  return (info.need > 0 ? "(" + info.need + ") " : "") + (page ? page + " – " : "") + APP_NAME;
}

// Whether a route change shows a different page (not the same one again).
export function isNewPage(prev: Route | null, next: Route): boolean {
  if (!prev || prev.view !== next.view) return true;
  if (prev.view === "tab" && next.view === "tab") return prev.tab !== next.tab;
  if (prev.view === "run" && next.view === "run") return prev.stamp !== next.stamp || prev.routine !== next.routine;
  if (prev.view === "pr" && next.view === "pr") return prev.n !== next.n || prev.routine !== next.routine;
  return "id" in prev && "id" in next && prev.id !== next.id;
}

// Focus goes to a detail page's heading once per navigation, never on a live re-render: a route change
// arms it, and the first render that has the heading takes it. A render before the data loads (the
// skeleton) keeps it armed; a loaded page without a heading (removed item, error) drops it.
export class HeadingFocus {
  private armed = false;
  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }
  take(loaded: boolean, hasHeading: boolean): boolean {
    if (!this.armed) return false;
    if (hasHeading || loaded) this.armed = false;
    return hasHeading;
  }
}
