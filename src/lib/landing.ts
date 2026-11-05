// Phones open on the top ask: launched on the Inbox with something that needs you, the app goes straight to the head
// of the queue, once per session (src/main.ts). Mid and desk open on the list (the split view).
import type { Route } from "../state.ts";
import type { Layout } from "./layout.ts";
import { openItems, type ItemRow } from "./items.ts";

// The sessionStorage key: set once the session's landing is decided, so a reload doesn't jump again. A new PWA launch
// is a new session.
export const LANDED_KEY = "agent-inbox-landed";

export interface LandingCheck {
  first: boolean;        // the boot's route, or the landing it left pending; never a later navigation
  layout: Layout;
  route: Route;          // where the page is now: it must still be the Inbox
  explicitItem: boolean; // the app opened on an item's URL (a Web Push tap, a shared link): never overridden
  landed: boolean;       // this session already decided its landing
  need?: number;         // open asks in the Inbox; undefined before the data loads (the landing waits for it)
}

// Whether to land on the top ask. With `need` unknown it says whether a landing is still possible (pending).
export function shouldLand(c: LandingCheck): boolean {
  if (!c.first || c.layout !== "phone" || c.explicitItem || c.landed) return false;
  if (c.route.view !== "tab" || c.route.tab !== "inbox") return false;
  return c.need === undefined || c.need > 0;
}

// The item to land on: the head of the triage order among the open asks (an FYI is never "the top ask"), or null.
export function landingTarget(items: ItemRow[], now = Date.now()): string | null {
  return openItems(items, now)[0]?.id ?? null;
}
