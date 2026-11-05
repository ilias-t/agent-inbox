// A URL hash's route (the app's one parser: src/main.ts routes by it, src/lib/backnav.ts compares pages by it).
// Plain-token hashes (#item.<id>, #orch.<id>, #inbox, #settings, and the Reviews tab's #run.<stamp>, #pr.<n>,
// #reviews.<routine>: src/lib/reviews.ts), as in the artifact; #/item/<id> is accepted too. No hash, or one that
// isn't a route, is the tab last shown (else the Inbox).
import type { Route, Tab } from "../state.ts";
import { parseReviewHash } from "./reviews.ts";

const TABS: readonly Tab[] = ["inbox", "team", "reviews", "history"];

export function parseHash(hash: string): Route {
  let h = hash.replace(/^#/, ""), m: RegExpMatchArray | null;
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  if ((m = h.match(/^\/?item[./](.+)$/))) return { view: "item", id: m[1] };
  if ((m = h.match(/^\/?orch[./](.+)$/))) return { view: "orch", id: m[1] };
  if (/^\/?settings$/.test(h)) return { view: "settings" };
  const rv = parseReviewHash(h); if (rv) return rv;
  if ((m = h.match(/^\/?(inbox|team|reviews|history)$/))) return { view: "tab", tab: m[1] as Tab };
  let saved: string | null = null;
  try { saved = localStorage.getItem("agent-inbox-tab"); } catch { /* default tab */ }
  return { view: "tab", tab: TABS.includes(saved as Tab) ? (saved as Tab) : "inbox" };
}
