import type {
  Doc, Item, Lease, ManagerMeta, Person, PinResponse, Pins, Principal, QaMessage, ReviewPrResponse, ReviewRun, Role, RoutineReviewsResponse, RoutineState, ScheduleView, Snoozes,
  StateResponse,
} from "../shared/types.ts";
import { mergePage, mergeState, oldestArchived, windowGap, type Cursor } from "./lib/archive.ts";
import { identityOf, type Synced } from "./lib/delta.ts";
import type { HistoryFilter } from "./lib/history.ts";
import { snoozeZone } from "./lib/snooze.ts";
import { filterAssignee, flattenItem, flattenOrch, isAssigneeFilter, type AssigneeFilter, type ItemRow, type OrchRow } from "./lib/items.ts";
import { roleOf } from "./lib/roles.ts";
import type { Layout } from "./lib/layout.ts";

export type Tab = "inbox" | "team" | "reviews" | "history";
export const TABS: Tab[] = ["inbox", "team", "reviews", "history"];
// `routine` on the Reviews tab (#reviews.<routine>) switches routine; on a run or PR page null means the one shown.
export type Route =
  | { view: "tab"; tab: Tab; routine?: string }
  | { view: "item"; id: string }
  | { view: "orch"; id: string }
  | { view: "run"; routine: string | null; stamp: string }
  | { view: "pr"; routine: string | null; n: number }
  | { view: "settings" };

// choice: null once cleared (a 409), so the pre-selected recommendation doesn't come back (src/lib/decide.ts).
// noteOpen: the phone's "Add a note" toggle was opened. recShown: the recommendation pre-selected when the page last
// rendered, so a live change to it clears the pre-selection instead of moving it (src/lib/decide.ts recMoved).
// seen: decisionPrint of the item as last shown, so a live change to its question or options clears the choice.
export interface Draft { choice?: string | null; note?: string; ovr?: boolean; noteOpen?: boolean; recShown?: string; seen?: string }
export interface AskDraft { open: boolean; text: string; busy: boolean; msg: string; kind: string }
export interface AssignDraft { open: boolean; email: string; busy: boolean; msg: string; kind: string }
export type QaMsg = QaMessage & { id: string };
export type Theme = "system" | "light" | "dark";

export const state = {
  loaded: false,
  // The server confirmed what's shown this session. Until then it may be the snapshot saved on this device.
  revalidated: false,
  staleSince: null as number | null, // ms: the snapshot shown is this old (marked in the header) until revalidated
  loadError: "" as string, // boot failed: shown instead of the lists
  signedOut: false,
  offline: false, // the offline banner shows: what's on screen may be stale (src/main.ts)
  items: [] as ItemRow[],
  orchestrators: [] as OrchRow[],
  meta: null as ManagerMeta | null,
  lease: null as Lease | null,
  schedule: null as ScheduleView | null,
  me: null as Principal | null,
  people: [] as Person[],                // names for assignees (topics stay server-side)
  snoozes: {} as Snoozes,                // the signed-in human's own snoozes: item id -> until (ISO)
  pins: {} as Pins,                      // the signed-in human's own pins: "<kind>:<ref>" -> pinned at (src/lib/pins.ts)
  pinBusy: new Set<string>(),            // pin keys being saved
  versions: new Map<string, number>(),   // item id -> doc version, the pin for a reassign
  cursor: 0,
  // The /api/state the page holds, deltas merged in (src/lib/delta.ts): what the next delta applies to, and what
  // the saved snapshot keeps (src/lib/snapshot.ts).
  base: null as StateResponse | null,
  tab: "inbox" as Tab,
  layout: "phone" as Layout,             // from the viewport width's media queries (src/main.ts, src/lib/layout.ts)
  route: { view: "tab", tab: "inbox" } as Route,
  prevRoute: null as Route | null,
  drafts: new Map<string, Draft>(),      // item id -> {choice, note}
  // item id -> {msg, kind}; alert: the decide status line says it as an alert (a 409), until it has rendered once.
  itemStatus: new Map<string, { msg: string; kind: string; alert?: boolean }>(),
  busy: new Set<string>(),               // item ids being saved
  shownSig: "",
  tickBusy: false,
  indexScroll: 0,
  navOrder: [] as string[],              // item pages: the inbox order last seen while the shown item was open
  advancedAt: 0,                         // ms of the last arrival at an item page, an auto-advance included (Submit and decision keys hold briefly)
  // Phones open on the top ask (src/main.ts land, src/lib/landing.ts): "pending" from the boot route until the data
  // first loads; "snapshot" after landing on the saved copy, on `id`, until the first revalidating sync re-checks it.
  landing: { phase: "idle" as "idle" | "pending" | "snapshot", id: "" },
  // Index j/k: each tab's cursor row (its href). Kept here because a re-render drops the focused row.
  rowCursor: { inbox: null, team: null, reviews: null, history: null } as Record<Tab, string | null>,

  ctxOpen: null as boolean | null,       // item page: orchestrator context expanded, as last toggled (null: open in the More sheet only)
  contextOpen: null as boolean | null,   // item page: the Context block, as last toggled (null: open on wide screens only)
  qa: { id: null as string | null, msgs: [] as QaMsg[], loaded: false, failed: false }, // thread of the item being shown
  asks: new Map<string, AskDraft>(),     // item id -> {open, text, busy, msg, kind}
  assigns: new Map<string, AssignDraft>(), // item id -> the reassign control's state
  assigneeFilter: "all" as AssigneeFilter, // Inbox: All / Mine / Unassigned (localStorage, per viewer)
  seen: {} as Record<string, number>,    // item id -> ms of the viewer's last look at its thread (localStorage)
  snoozeMenu: null as string | null,     // item page: the item whose Snooze menu is open
  snoozedOpen: false,                    // Inbox: the Snoozed group expanded
  historyQuery: "",                      // History: the search, as last applied (debounced)
  historyFilter: "all" as HistoryFilter, // History: All / Decided by me / Auto-decided / Overridden

  // Every loaded item doc by id: /api/state's (all open/decided/processing, the newest archived) plus older archived
  // pages History loaded (src/lib/archive.ts). `items` and `versions` are derived from it.
  docs: new Map<string, Doc<Item>>(),
  // Older archived pages: where Load older continues from, whether there is more, and the server's archived count.
  archive: { seeded: false, cursor: null as Cursor | null, more: false, total: 0, loading: false },
  // History search's server hits (GET /api/items?q=) for archived items not loaded yet.
  historySearch: { q: "", hits: [] as ItemRow[], more: false, loading: false, failed: false },
  // Items shown on their own page that aren't loaded (an older archived item): fetched by id, or a search hit.
  extra: new Map<string, ItemRow>(),
  itemFetch: new Map<string, "loading" | "missing" | "failed">(),

  // The Reviews tab (src/views/reviews.ts): the routine asked for (#reviews.<routine>, saved per viewer), its
  // GET /api/reviews/:routine (refetched once its head's version in /api/state moves on), Runs or PRs, the folded
  // groups opened, and runs older than the loaded page fetched for their own page.
  reviews: {
    want: null as string | null,
    data: null as RoutineReviewsResponse | null,
    loading: false,
    failed: "",
    view: "prs" as "runs" | "prs",
    open: new Set<string>(),
    runs: new Map<string, ReviewRun | "loading" | "missing" | "failed">(),
    // A PR page's GET /api/reviews/:routine/prs/:n by "<routine>/<n>", and the head version it was fetched at.
    prs: new Map<string, { version: number | null; state: "loading" | "ok" | "missing" | "failed"; data: ReviewPrResponse | null }>(),
    tl: "all" as "all" | "routine" | "author" | "you", // the PR timeline's filter
    // Runs before the newest page (Load older, ?before=): which routine they belong to, and whether there are more.
    older: { routine: null as string | null, runs: [] as ReviewRun[], more: null as boolean | null, loading: false },
  },
};
try { state.reviews.want = localStorage.getItem("agent-inbox-routine"); } catch { /* the default routine */ }
try { if (localStorage.getItem("agent-inbox-reviews-view") === "runs") state.reviews.view = "runs"; } catch { /* PRs */ }

// The routines that have reported (/api/state `routines`): the Reviews tab shows only when there is one.
export function routines(): RoutineState[] { return state.base?.routines ?? []; }
export function setReviewsView(v: "runs" | "prs"): void {
  state.reviews.view = v;
  try { localStorage.setItem("agent-inbox-reviews-view", v); } catch { /* not persisted */ }
}
export function setRoutine(id: string): void {
  state.reviews.want = id; state.reviews.failed = "";
  try { localStorage.setItem("agent-inbox-routine", id); } catch { /* not persisted */ }
}
try { state.seen = JSON.parse(localStorage.getItem("agent-inbox-seen") || "{}") || {}; } catch { state.seen = {}; }
try { const f = localStorage.getItem("agent-inbox-assignee"); if (isAssigneeFilter(f)) state.assigneeFilter = f; } catch { /* default All */ }

export function setAssigneeFilter(f: AssigneeFilter): void {
  state.assigneeFilter = f;
  try { if (f === "all") localStorage.removeItem("agent-inbox-assignee"); else localStorage.setItem("agent-inbox-assignee", f); } catch { /* not persisted */ }
}
// The signed-in human's email, lowercased; null for a token.
export function myEmail(): string | null { return state.me && state.me.kind === "human" ? state.me.email.toLowerCase() : null; }
// The signed-in human's role (src/lib/roles.ts); null for a token.
export function myRole(): Role | null { return roleOf(state.me); }
// The items the Inbox tab, its counts and the item pager work through: all of them, or the filter's.
export function inboxItems(): ItemRow[] { return filterAssignee(state.items, state.assigneeFilter, myEmail()); }

function syncItems(): void {
  const docs = [...state.docs.values()];
  state.items = docs.map((d) => flattenItem(d, state.snoozes));
  state.versions = new Map(docs.map((d) => [d.id, d.version]));
}

// What a sync brought: a full /api/state, or the held one with a delta merged in. A full one for someone else than
// the identity shown (another account signed in) replaces everything, History's older pages and drafts included.
// A full one confirming a saved snapshot replaces its docs: an archived one it held beyond the new window may be
// gone, and only items History paged in this session are kept past the window.
export function applySync(r: Synced): void {
  if (r.full && state.me && identityOf(r.state.me) !== identityOf(state.me)) resetData();
  else if (r.full && !state.revalidated) { state.docs = new Map(); state.extra = new Map(); state.archive.seeded = false; }
  applyState(r.state, r.full ? [] : r.deleted);
  state.revalidated = true; state.staleSince = null;
  // The server answered again: items fetched by id that failed (offline, a server error) are tried again on the next
  // render (an older item's page, History's pinned ones); those it said are gone stay so.
  for (const [id, f] of state.itemFetch) if (f === "failed") state.itemFetch.delete(id);
}

// Everything loaded for the signed-in identity: dropped when another one signs in, or when the session turns out
// to be gone before the snapshot shown at boot was confirmed.
export function resetData(): void {
  state.loaded = false; state.staleSince = null;
  state.base = null;
  state.docs = new Map(); state.items = []; state.versions = new Map(); state.extra = new Map(); state.itemFetch = new Map();
  state.orchestrators = []; state.meta = null; state.lease = null; state.schedule = null; state.me = null;
  state.people = []; state.snoozes = {}; state.pins = {}; state.cursor = 0;
  state.archive = { seeded: false, cursor: null, more: false, total: 0, loading: false };
  state.historySearch = { q: "", hits: [], more: false, loading: false, failed: false };
  state.drafts = new Map(); state.itemStatus = new Map(); state.asks = new Map(); state.assigns = new Map();
  state.qa = { id: null, msgs: [], loaded: false, failed: false };
  Object.assign(state.reviews, { data: null, loading: false, failed: "", runs: new Map(), prs: new Map(), older: { routine: null, runs: [], more: null, loading: false } });
}

// A live refetch merges by id: older archived pages already loaded stay (src/lib/archive.ts). `drop`: item ids a
// delta deleted, which an older page loaded beyond the held window may still hold.
export function applyState(s: StateResponse, drop: string[] = []): void {
  state.base = s;
  const a = state.archive, gap = a.seeded && windowGap(state.docs, s);
  state.docs = gap ? new Map(s.items.map((d) => [d.id, d])) : mergeState(state.docs, s);
  for (const id of drop) { state.docs.delete(id); state.extra.delete(id); }
  state.snoozes = s.snoozes || {}; // before syncItems, which reads it
  state.pins = s.pins || {};
  syncItems();
  if (!a.seeded || gap) { a.seeded = true; a.cursor = oldestArchived(s.items); a.more = !!s.archived_more; }
  else if (!s.archived_more) a.more = false; // the snapshot holds every archived item now
  a.total = s.archived_total ?? 0;
  state.people = s.people || [];
  state.orchestrators = s.orchestrators.map(flattenOrch);
  state.meta = s.manager ? s.manager.data : null;
  state.lease = s.lease ? s.lease.data : null;
  state.schedule = s.schedule;
  state.me = s.me;
  state.cursor = s.cursor; // a full fetch's even when lower (another database): a delta from a higher one never applies
  state.loaded = true;
  state.loadError = "";
}

// Merge a doc a write just returned, so the page updates before the next poll.
export function applyItem(d: Doc<Item>): void {
  const row = flattenItem(d, state.snoozes);
  state.docs.set(d.id, d);
  state.extra.delete(d.id);
  state.versions.set(d.id, d.version);
  const i = state.items.findIndex((x) => x.id === row.id);
  if (i >= 0) state.items[i] = row; else state.items.push(row);
}

// The viewer's own snooze a write just returned (null: woken), so the Inbox updates before the next poll.
export function applySnooze(id: string, until: string | null): void {
  const next = { ...state.snoozes };
  if (until === null) delete next[id]; else next[id] = until;
  state.snoozes = next;
  syncItems();
}

// The viewer's own pin a write just returned, so the lists update before the next poll. The held snapshot takes it
// too, so a delta merged before the one carrying it doesn't put the old map back.
export function applyPin(r: PinResponse): void {
  const key = r.kind + ":" + r.ref, next = { ...state.pins };
  if (r.pinned && r.created_at) next[key] = r.created_at; else delete next[key];
  state.pins = next;
  if (state.base) state.base = { ...state.base, pins: next };
}

// A page of older archived items (History's Load older).
export function applyOlderPage(page: Doc<Item>[], more: boolean): void {
  state.docs = mergePage(state.docs, page);
  syncItems();
  const last = page[page.length - 1];
  if (last) state.archive.cursor = { at: last.updated_at, id: last.id };
  state.archive.more = more;
}

// Where snooze presets and wake times are computed: the schedule's zone, else this browser's.
// Memoized on the schedule's zone: checking a zone builds an Intl.DateTimeFormat, and History asks per row.
let zoneFor: { tz: string | undefined; zone: string } | null = null;
export function scheduleZone(): string {
  const tz = state.schedule?.schedule.timezone;
  if (!zoneFor || zoneFor.tz !== tz) zoneFor = { tz, zone: snoozeZone(tz) };
  return zoneFor.zone;
}

// A loaded item, else one fetched for its own page or found by History's server search.
export function itemById(id: string): ItemRow | null { return state.items.find((x) => x.id === id) || state.extra.get(id) || null; }
export function orchById(id: string | null | undefined): OrchRow | null { return id == null ? null : state.orchestrators.find((o) => o.id === id) || null; }

// At most every 5 s, unless `force`d (an answer the viewer hasn't seen yet is on screen). True when it recorded a look.
export function markSeen(id: string, force = false): boolean {
  const now = Date.now();
  if (!force && state.seen[id] && now - state.seen[id] < 5000) return false;
  state.seen[id] = now;
  try { localStorage.setItem("agent-inbox-seen", JSON.stringify(state.seen)); } catch { /* private mode */ }
  return true;
}

/* ---------- theme: System / Light / Dark, applied as :root[data-theme] ---------- */
const THEME_COLOR = { light: "#f4f5f7", dark: "#0c0f14" };
export function getTheme(): Theme {
  try { const t = localStorage.getItem("agent-inbox-theme"); if (t === "light" || t === "dark") return t; } catch { /* default */ }
  return "system";
}
export function setTheme(t: Theme): void {
  try { if (t === "system") localStorage.removeItem("agent-inbox-theme"); else localStorage.setItem("agent-inbox-theme", t); } catch { /* not persisted */ }
  applyTheme(t);
}
export function applyTheme(t: Theme = getTheme()): void {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
  // Both theme-color metas follow an explicit choice; with System they keep their media queries.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const scheme = /dark/.test(m.media) ? "dark" : "light";
    m.content = THEME_COLOR[t === "system" ? scheme : t];
  });
}
