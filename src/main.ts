import "./fonts.css";
import "./style.css";
import { computeSchedule } from "../shared/schedule.ts";
import type { Change } from "../shared/types.ts";
import { $, announce, esc, hideToast, toast } from "./lib/dom.ts";
import { offlineText } from "./lib/status.ts";
import { isAsk, itemHref, openItems, orchHref } from "./lib/items.ts";
import { LANDED_KEY, landingTarget, shouldLand } from "./lib/landing.ts";
import { DESK_QUERY, MID_QUERY, isSplit, layoutOf } from "./lib/layout.ts";
import { Arrivals, arrival, backLabel, backTarget, goUp, listOf, navigate, replaceWith, savedNav, type Arrival } from "./lib/backnav.ts";
import { HeadingFocus, isNewPage } from "./lib/page.ts";
import { routeHref } from "./lib/reviews.ts";
import { parseHash } from "./lib/route.ts";
import { relTime } from "./lib/time.ts";
import { registerServiceWorker } from "./pwa.ts";
import { identityOf, type Synced } from "./lib/delta.ts";
import { clearSnapshot, isStale, readSnapshot, saveSnapshot, STALE_MS, toSnapshot } from "./lib/snapshot.ts";
import { ApiError, onSignedOut, store } from "./store.ts";
import { TABS, applyState, applySync, applyTheme, inboxItems, itemById, resetData, scheduleZone, setRoutine, state, type Route, type Tab } from "./state.ts";
import { renderLease, renderMeta, renderNav, renderOfflineBanner, syncTitle, wireDigest, wireTickForm } from "./views/header.ts";
import {
  focusCursorRow, invalidateTabs, markCurrentRow, refreshHistoryDays, renderHistory, renderInbox, renderPlaceholder, renderReviews, renderTeam, showTab,
  wireFyiRows, wireHistory, wireInboxFilter, wireSnoozed,
} from "./views/index.ts";
import { leaveMore, loadQa, renderItemPage, whenRowsChange } from "./views/item.ts";
import { wireKeys } from "./views/keys.ts";
import { wirePins } from "./views/pins.ts";
import { renderOrchPage } from "./views/orch.ts";
import { currentRoutine, forgetFailedPrs, loadOlderRuns, loadReviews, onReviewsLoaded, renderPrPage, renderRunPage, wireReviewPane, wireReviewsSeg } from "./views/reviews.ts";
import { refreshPeople, renderSettingsPage } from "./views/settings.ts";

/* ---------- routing ---------- */
function parseRoute(): Route { return parseHash(location.hash || ""); }

// A run's or a PR's page: its list is Reviews.
const isReview = (r: Route) => r.view === "run" || r.view === "pr";

// Where a detail page's back link goes when it doesn't lead to an orchestrator page: the list it was opened from. Set
// by list routes only (and a split view's first load on an orchestrator page), not by the list a pane shows (state.tab,
// Team beside an orchestrator page), so a layout change never moves it.
let returnTab: Tab = state.tab;

// A navigation (not the first load, not a live re-render) moves focus to the detail page's heading.
const headingFocus = new HeadingFocus();

// `relayout`: the same route again for a new layout (see watchLayout): where Back goes, the scroll position, focus and
// the page shown stay as they are.
// From 700px (the split view) the list and the item sit side by side, each pane scrolling on its own: an item route
// keeps the list of the tab it was opened from beside it, an orchestrator route the Team list, and a list route shows a
// placeholder where the item goes.
// The page itself doesn't scroll there, so window scroll positions aren't saved or restored.
// `from`: the hash navigated from (hashchange's oldURL), kept on the new entry so going up to it can step back.
// `how`: arrived by Back or Forward, or by a replace that carries the predecessor (src/lib/backnav.ts Arrivals).
const arrivals = new Arrivals();
function route(initial = false, relayout = false, from: string | null = null, how: Arrival = { traversed: false, replacedFrom: undefined }): void {
  const r = parseRoute(), wasIndex = state.route.view === "tab", split = isSplit(state.layout);
  const rowOpened = openedFromRow; openedFromRow = false;
  if (!relayout) {
    if (r.view !== "tab" && wasIndex && !split) state.indexScroll = window.scrollY || 0;
    state.prevRoute = state.route; state.shownSig = "";
  }
  state.route = r;
  if (initial) armLanding(r);
  else if (!relayout) landingRouted(r);
  // The More sheet belongs to the item it opened on: leaving it (or moving on to the next one) closes it.
  if (!relayout && (r.view !== "item" || isNewPage(state.prevRoute, r))) leaveMore(true);
  // Arriving at an item (an auto-advance, a row, prev/next, a push tap) starts the settle window: its Submit and
  // decision keys wait a moment, so a tap or key meant for what was there before doesn't decide this one unseen.
  if (!relayout && r.view === "item" && isNewPage(state.prevRoute, r)) state.advancedAt = Date.now();
  if (!relayout && r.view === "pr" && isNewPage(state.prevRoute, r)) forgetFailedPrs();
  document.documentElement.dataset.route = r.view; // tab | item | orch | run | pr | settings: which shell parts show (style.css)
  // #reviews.<routine>, and a run or PR link that names its routine, switch the routine shown (kept for next time).
  const wantRoutine = r.view === "tab" ? r.routine : isReview(r) ? r.routine : undefined;
  if (wantRoutine && wantRoutine !== state.reviews.want) { setRoutine(wantRoutine); invalidateTabs(); }
  if (!(r.view === "item" && r.id === state.snoozeMenu)) state.snoozeMenu = null; // the Snooze menu doesn't follow you around
  syncQa();
  if (r.view !== "item") { $("pager").hidden = true; $("peek").hidden = true; }
  if (r.view === "tab") {
    headingFocus.disarm();
    state.tab = returnTab = r.tab; state.navOrder = [];
    try { localStorage.setItem("agent-inbox-tab", r.tab); } catch { /* not persisted */ }
    for (const t of TABS) $("view-" + t).hidden = t !== r.tab;
    $("manager").hidden = r.tab === "reviews"; // the routine's own card is the Reviews tab's
    $("index-view").hidden = false; $("detail-view").hidden = true;
    // Only the shown tab's list is built (the others when shown, if anything changed since they were built).
    renderMeta(); showTab(r.tab, initial); renderPlaceholder(); markCurrentRow();
    if (!wasIndex && !initial && !relayout) focusCursorRow(r.tab); // back from a detail page: focus the row that was opened
    if (!wasIndex && !relayout && !split) window.scrollTo(0, state.indexScroll || 0);
  } else {
    const p = state.prevRoute, back = $<HTMLAnchorElement>("back-link");
    // Where its back link, u and Esc go: this history entry's own (Back, Forward, a reload, a new layout), else worked
    // out now, on arriving, and kept on the entry, so coming back to it never recomputes it from the page just left
    // (src/lib/backnav.ts).
    let nav = savedNav(history.state);
    if (nav) returnTab = nav.ret;
    else {
      if (initial && split && r.view === "orch") returnTab = "team";
      else if (initial && isReview(r)) returnTab = "reviews";
      const known = arrival(how.traversed, p, back.getAttribute("href"), rowOpened, how.replacedFrom === undefined ? from : how.replacedFrom);
      const to = backTarget(r, known.prev, returnTab, known.kept, known.rowOpened);
      // An item's list: the one its back goes up to; from an orchestrator page, the list shown with it (Team beside it,
      // the one Back returns to on a phone).
      const tab = !to.startsWith("#orch.") ? listOf(to) : split ? state.tab : returnTab;
      nav = { back: to, ret: returnTab, tab, from: known.from };
      try { history.replaceState({ ...(history.state as object | null), nav }, ""); } catch { /* not kept: worked out again */ }
    }
    back.href = nav.back; $("back-label").textContent = backLabel(nav.back, r.view);
    // Split: the list stays beside the page: an item's own, Team beside an orchestrator page, Reviews beside a run or
    // PR. Settings is alone; on a phone every detail page is, and the list kept is the one Back returns to.
    const beside = split && r.view !== "settings";
    if (r.view === "item") state.tab = nav.tab;
    else if (beside && r.view === "orch") state.tab = "team";
    else if (isReview(r)) state.tab = "reviews";
    else if (!split) state.tab = returnTab;
    $("index-view").hidden = !beside; $("detail-view").hidden = false;
    if (beside) { for (const t of TABS) $("view-" + t).hidden = t !== state.tab; $("manager").hidden = state.tab === "reviews"; renderMeta(); }
    else invalidateTabs(); // "answered" dots depend on what is viewed here: every list rebuilds when next shown
    // The index cursor follows what's opened (and paged to), so back on the list j/k continue from it.
    if (r.view === "item" && state.tab !== "team") state.rowCursor[state.tab] = itemHref(r.id);
    else if (r.view === "orch") state.rowCursor.team = orchHref(r.id);
    else if (isReview(r)) state.rowCursor.reviews = routeHref(r, currentRoutine());
    // A new page starts unfocused: an option button focused on the last item mustn't carry over to this one.
    if (!relayout && isNewPage(p, r)) {
      (document.activeElement as HTMLElement | null)?.blur();
      if (!initial) headingFocus.arm();
    }
    // From 700px the back link shows only when it leads to the orchestrator page the item was opened from: back to
    // the list beside it is u / Esc (src/views/keys.ts follows this link either way).
    back.classList.toggle("toorch", back.hash.startsWith("#orch"));
    back.classList.toggle("toqueue", r.view === "item" && back.hash === "#inbox");
    // The item pane scrolls on its own in the split view: a new item starts at its top there.
    if (!relayout && !beside) window.scrollTo(0, 0);
    else if (!relayout && isNewPage(p, r)) $("detail").scrollTop = 0;
    renderDetail();
    // The list beside it: built if it's stale (first shown, or after the phone layout), its row marked and in view.
    if (beside) { showTab(state.tab, false); markCurrentRow(true); }
  }
  renderNav();
  syncTitle();
}
window.addEventListener("hashchange", (ev) => {
  let from: string | null = null;
  try { from = new URL(ev.oldURL).hash || "#"; } catch { /* a hashchange without its old URL */ }
  route(false, false, from, arrivals.take());
});
// A plain click (or Enter) on a list row, as opposed to paging: the route it leads to sets its own back target.
let openedFromRow = false;
document.addEventListener("click", (ev) => {
  const a = (ev.target as Element).closest<HTMLAnchorElement>("#index-view a.row");
  // Not its own row again (no route follows), nor one opening elsewhere (a new tab or window).
  if (a && a.hash !== location.hash && ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) openedFromRow = true;
}, true);
// The back link steps back in history when it returns to the page before (src/lib/backnav.ts goUp), as u and Esc do.
$("back-link").addEventListener("click", (ev) => {
  if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  goUp(ev.currentTarget as HTMLAnchorElement);
});

/* ---------- landing: a phone opens on the top ask (src/lib/landing.ts) ---------- */
// Once per session: the boot's route marks it pending, and it's decided when the data first loads (the saved copy or
// the server's). Landing replaces the boot entry with #inbox and pushes the item, so Back goes to the queue. A
// navigation before then cancels it; a landing on the saved copy is re-checked by the first sync from the server.
// A session that opened anywhere but the Inbox (a push tap on an item, a link to History) has had its opening.
// Decided is remembered in sessionStorage and, where that throws (private mode), on the history entry, so a reload of
// the queue doesn't jump either way.
function landedThisSession(): boolean {
  if ((history.state as { landed?: boolean } | null)?.landed) return true;
  try { return sessionStorage.getItem(LANDED_KEY) === "1"; } catch { return false; }
}
function markLanded(): void {
  try { history.replaceState({ ...(history.state as object | null), landed: true }, ""); } catch { /* not on the entry */ }
  try { sessionStorage.setItem(LANDED_KEY, "1"); } catch { /* the entry has it */ }
}
function armLanding(r: Route): void {
  const landed = landedThisSession();
  if (shouldLand({ first: true, layout: state.layout, route: r, explicitItem: r.view === "item", landed })) state.landing = { phase: "pending", id: "" };
  else if (!landed && !(r.view === "tab" && r.tab === "inbox")) markLanded();
}
// The route of the URL now. state.route lags it until the hashchange handler runs: a tap or a push message may have
// moved on while the data loaded, and the landing must not overwrite where it went.
function sameRoute(a: Route, b: Route): boolean {
  return a.view === b.view && !isNewPage(a, b);
}
// A route change other than the landing's own: a pending landing is off, and so is the re-check once you've left it.
function landingRouted(r: Route): void {
  const L = state.landing;
  if (L.phase === "pending") { state.landing = { phase: "idle", id: "" }; markLanded(); }
  else if (L.phase === "snapshot" && !(r.view === "item" && r.id === L.id)) state.landing = { phase: "idle", id: "" };
}
// What the viewer did on the item landed on: a choice, a note, an override or a question being written.
function hasInput(id: string): boolean {
  const d = state.drafts.get(id), ask = state.asks.get(id);
  return !!(d && ("choice" in d || (d.note || "").trim() || d.ovr || d.noteOpen)) || !!(ask && (ask.open || ask.text.trim()));
}
// `snapshot`: the data just shown is the copy saved on this device, not yet confirmed by the server.
function land(snapshot: boolean): void {
  const L = state.landing;
  if (L.phase === "pending") {
    state.landing = { phase: "idle", id: "" }; markLanded();
    const items = inboxItems(), top = landingTarget(items), here = parseRoute();
    if (!top || !sameRoute(here, state.route)) return;
    if (!shouldLand({ first: true, layout: state.layout, route: here, explicitItem: false, landed: false, need: openItems(items).length })) return;
    if (snapshot) state.landing = { phase: "snapshot", id: top };
    history.replaceState({ landed: true }, "", "#inbox");
    navigate(itemHref(top));
    // Routed now, not on the hashchange (which routes to the same page again), so the list doesn't flash first; as the
    // boot's route, a cold start like a push tap's: focus stays where a page load leaves it.
    route(true, false, "#inbox");
  } else if (L.phase === "snapshot" && !snapshot) {
    state.landing = { phase: "idle", id: "" };
    const r = parseRoute(), it = itemById(L.id);
    // Closed (or gone) while the device was away: on to the queue's new head, in place of it (Back still goes to the
    // queue), unless the viewer already started on it or the URL has moved on.
    if (r.view !== "item" || r.id !== L.id || !sameRoute(r, state.route) || (it && isAsk(it)) || hasInput(L.id)) return;
    const top = landingTarget(inboxItems());
    replaceWith(top ? itemHref(top) : "#inbox");
    route(false, false, null, arrivals.take()); // now: the closed item's verdict mustn't flash first; with what the replace carries
  }
}

/* ---------- layout: phone / mid / desk (src/lib/layout.ts), as html[data-layout] ---------- */
// The same media queries as style.css, so the layout state and the CSS never disagree. A change re-runs route() in
// place: the split view (from 700px) will show different panes for the same route.
function watchLayout(): void {
  const mid = window.matchMedia(MID_QUERY), desk = window.matchMedia(DESK_QUERY);
  const apply = (): boolean => {
    const l = layoutOf(mid.matches, desk.matches), changed = l !== state.layout;
    state.layout = l; document.documentElement.dataset.layout = l;
    return changed;
  };
  apply();
  const onChange = () => { if (apply()) route(false, true); };
  mid.addEventListener("change", onChange); desk.addEventListener("change", onChange);
}

// The thread of the item being shown: fetched on route change and when the change feed touches it.
function syncQa(): void {
  const want = state.route.view === "item" && state.loaded ? state.route.id : null;
  if (state.qa.id === want) return;
  state.qa = { id: want, msgs: [], loaded: false, failed: false };
  if (want) loadQa(want);
}

function renderDetail(): void {
  const r = state.route, box = $("detail");
  if (r.view === "tab") return;
  // The page is replaced without renderItemPage: the More sheet mustn't keep showing the item's blocks.
  if ((state.signedOut && !state.loaded) || state.loadError || r.view !== "item") leaveMore();
  if (state.signedOut && !state.loaded) { state.shownSig = "signedout"; box.innerHTML = '<div class="panel empty"><strong>Signed out.</strong><span class="small">Reload to sign in again.</span></div>'; }
  else if (state.loadError) { state.shownSig = "error"; box.innerHTML = '<div class="panel empty"><strong>The inbox couldn\'t load.</strong><span class="small">' + esc(state.loadError) + '</span><button type="button" class="btn" data-retry>Try again</button></div>'; }
  else if (r.view === "item") renderItemPage(r.id, box);
  else if (r.view === "orch") renderOrchPage(r.id, box);
  else if (r.view === "run") renderRunPage(r.stamp, box);
  else if (r.view === "pr") renderPrPage(r.n, box);
  else renderSettingsPage(box);
  const heading = box.querySelector<HTMLElement>('h2[tabindex="-1"]');
  // A page still loading its own data (a run or PR before Reviews has loaded, an older item) keeps focus waiting.
  if (headingFocus.take(state.loaded && !box.querySelector('.skel[aria-busy="true"]'), !!heading)) heading?.focus({ preventScroll: true });
}

// Hidden tabs only update their counts here; their lists are built when shown (src/lib/tabs.ts).
function renderAll(): void { renderMeta(); renderLease(); renderInbox(); renderTeam(); renderReviews(); renderHistory(); renderDetail(); }

// The schedule's in-hours / next-pickup view is recomputed locally, so the header stays right between polls.
function recomputeSchedule(): void {
  const v = state.schedule; if (!v) return;
  try { state.schedule = { ...v, computed: computeSchedule(v.schedule, new Date()) }; } catch { /* keep the server's view */ }
}

// Keep relative times and the schedule fresh without rebuilding anything.
setInterval(() => {
  document.querySelectorAll<HTMLElement>(".rel[data-ts]").forEach((s) => { s.textContent = relTime(s.dataset.ts, !!s.dataset.compact); });
  recomputeSchedule();
  renderMeta(); renderLease();
  renderInbox(); // a snoozed item whose time came is back in the list, the badge and the tab title
  refreshHistoryDays(); // past midnight, Today is Yesterday
  if (state.offline) renderOfflineBanner(true, shownFrom); // "from 14:12" becomes "from Thu 14:12" the next day
  if (state.route.view === "item") renderDetail(); // pickupPhrase() may have changed; the signature skips no-op renders
  renderReviews(); // "next 16:15", Today and the routine's overdue warning move with the clock
}, 60000);

/* ---------- snapshot: the last good state, saved on this device (src/lib/snapshot.ts) ---------- */
// Saved a moment after each sync, and when the page goes to the background (so its age reads from then), only
// once the server confirmed it this session and while signed in.
let saveTimer: ReturnType<typeof setTimeout> | undefined, lastSaved = 0, unsaved = false;
function saveSoon(): void {
  unsaved = true;
  clearTimeout(saveTimer);
  // After a live change, when the main thread is idle: the copy and the structured clone aren't free at scale.
  saveTimer = setTimeout(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => saveNow(), { timeout: 5000 });
    else saveNow();
  }, 2000);
}
function saveNow(): void {
  clearTimeout(saveTimer);
  if (!state.base || !state.revalidated || state.signedOut) return;
  // Nothing new since the last save: only refresh its age now and then, not on every app switch.
  if (!unsaved && Date.now() - lastSaved < STALE_MS / 2) return;
  unsaved = false; lastSaved = Date.now();
  void saveSnapshot(toSnapshot(state.base, lastSaved));
}
document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
window.addEventListener("pagehide", () => saveNow());

// Render the saved snapshot at once; boot then revalidates it with a delta from its cursor. Never over live data.
async function showSnapshot(): Promise<void> {
  const snap = await readSnapshot(1000);
  if (!snap || state.loaded || state.signedOut) return;
  applyState(snap.state); recomputeSchedule(); snapshotAt = snap.savedAt;
  state.staleSince = isStale(snap.savedAt, Date.now()) ? snap.savedAt : null;
  syncQa(); land(true); renderAll();
}

/* ---------- boot ---------- */
onSignedOut(() => {
  state.signedOut = true;
  clearTimeout(saveTimer);
  void clearSnapshot();
  // A snapshot from this device, never confirmed: don't leave it on screen for someone who isn't signed in.
  if (!state.revalidated && state.loaded) resetData();
  toast("Signed out — reload to sign in again", true);
  leaveMore(true); // nothing of the item stays open in the More sheet
  if (!state.loaded) renderAll();
});

// A boot that got no answer retries by itself: at once when the device comes back online, else with backoff.
let booting = false, bootRetry: ReturnType<typeof setTimeout> | undefined, bootDelay = 2000;
function retryBoot(): void {
  if (booting) return; // the boot in flight retries itself if it fails
  clearTimeout(bootRetry); state.loadError = ""; renderAll(); boot();
}
document.addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).closest("[data-retry]")) retryBoot();
});
// The Copy button on a code block (src/lib/md.ts): the code is the <pre> beside it.
document.addEventListener("click", async (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-code]");
  if (!btn) return;
  const text = btn.parentElement?.querySelector("pre")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  } catch { toast("Couldn't copy. Select the text and copy it by hand."); }
});

/* ---------- offline ---------- */
// An inline banner while the device says it's offline, or the server can't be reached at all (the live-update
// loop's health, or a boot that got no answer). It replaces the sticky "reload" toast, which now only shows when
// the server answers with errors.
let unreachable = false;
// When the inbox on screen was last confirmed by the server: the moment the connection went (live updates were
// keeping it current until then), else the saved copy's time while it hasn't been confirmed. The banner shows it.
let snapshotAt: number | null = null, shownFrom: number | null = null;
function renderOffline(): void {
  const offline = !navigator.onLine || unreachable;
  if (offline && (!state.offline || shownFrom === null)) shownFrom = state.revalidated ? Date.now() : state.loaded ? snapshotAt : null;
  renderOfflineBanner(offline, shownFrom);
  if (offline === state.offline) return;
  announce(offline ? offlineText(shownFrom, scheduleZone()) : "Back online.");
  // The header status line stops warning "manager may be down" from stale data while offline, and resumes after.
  state.offline = offline; renderMeta(); renderLease();
}
window.addEventListener("offline", renderOffline);
window.addEventListener("online", () => {
  renderOffline();
  if ((state.loadError && !state.loaded) || (state.loaded && !state.revalidated)) retryBoot();
});

// The open item's thread is refetched when a sync says it changed: a delta lists it in qa_changed; a full refetch
// doesn't, so the change feed's report of it is remembered until then.
let qaDirty = false;
function onChanges(changes: Change[]): void {
  const id = state.route.view === "item" ? state.route.id : null;
  if (id && changes.some((c) => c.collection === "items/" + id + "/qa")) qaDirty = true;
  if (changes.some((c) => c.collection === "users")) refreshPeople(); // a role or name changed
}

function onSync(r: Synced): void {
  const id = state.route.view === "item" ? state.route.id : null;
  const qaChanged = !!id && (r.full ? qaDirty : r.qa.includes(id));
  qaDirty = false;
  // Another account signed in: what was saved for the last one goes (applySync drops what's shown).
  if (r.full && state.me && identityOf(r.state.me) !== identityOf(state.me)) void clearSnapshot();
  applySync(r); recomputeSchedule(); // revalidated from here on
  state.reviews.failed = ""; // a Reviews fetch that failed is tried again, if the tab is showing
  const shown = state.qa.id;
  syncQa(); // a first load, or a reset, opens the thread itself
  if (qaChanged && id && shown === id) loadQa(id);
  land(false);
  renderAll();
  saveSoon();
}

let stopWatch: (() => void) | null = null;
let failingShown = false;
let snapshotTried = false;
async function boot(): Promise<void> {
  booting = true;
  try {
    if (!snapshotTried) { snapshotTried = true; await showSnapshot(); }
    // A delta from the snapshot's cursor when one is shown, else the full state.
    const r = await store.sync(state.base);
    unreachable = false; renderOffline(); bootDelay = 2000;
    onSync(r);
    stopWatch?.();
    stopWatch = store.watch(state.cursor, {
      base: () => state.base,
      onSync,
      onChanges,
      onHealth: (h, network) => {
        if (h === "failing") {
          if (network || !navigator.onLine) { unreachable = true; renderOffline(); }
          else { failingShown = true; toast("Live updates stopped. Reload to reconnect.", true); }
          return;
        }
        if (unreachable) { unreachable = false; renderOffline(); }
        if (failingShown) { failingShown = false; toast("Live updates reconnected."); }
      },
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return; // onSignedOut already rendered it
    const network = e instanceof ApiError && e.status === 0;
    if (network) { unreachable = true; renderOffline(); }
    // A saved snapshot is on screen: it stays (the header says how old it is) while boot keeps retrying.
    if (state.loaded) {
      if (!network) toast("Couldn't refresh: " + (e instanceof ApiError ? "the server answered " + e.status : "something went wrong") + ". Retrying…");
      bootRetry = setTimeout(retryBoot, bootDelay); bootDelay = Math.min(30000, bootDelay * 2);
      return;
    }
    if (network && navigator.onLine) { bootRetry = setTimeout(retryBoot, bootDelay); bootDelay = Math.min(30000, bootDelay * 2); }
    state.loadError = e instanceof ApiError && e.status ? "The server answered " + e.status + (e.message ? ": " + e.message : "") + "." : "Check your connection.";
    renderAll();
  } finally {
    booting = false;
  }
}

applyTheme();
$("toast-close").addEventListener("click", hideToast);
registerServiceWorker();
renderOffline();
wireTickForm();
wireDigest();
wireInboxFilter();
wireSnoozed();
wireFyiRows();
wireHistory();
wireReviewsSeg(() => renderReviews());
wireReviewPane();
// A routine's data landed (or failed): its list, and a run or PR page showing it.
onReviewsLoaded(() => {
  renderReviews();
  if (isReview(state.route)) { renderDetail(); markCurrentRow(); syncTitle(); }
});
document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("[data-rv-retry]")) loadReviews(true);
  // Load older keeps focus: on the button while there are more, else on the last run. Only while that list is still
  // shown (same page, routine and view) and focus is where the busy redraw left it: a page opened meanwhile keeps it,
  // and so does a spot the user moved to while it loaded (focusin is tracked; an action link, which the redraw can't
  // keep, gets focus back).
  if (t.closest("[data-rv-older]")) {
    const from = location.hash, routine = currentRoutine();
    let moved: { href: string; n: number } | null = null, movedAway = false;
    const track = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-rv-older]")) return;
      movedAway = true;
      const act = el.closest<HTMLAnchorElement>("#reviews-list a.rvact");
      moved = act ? { href: act.getAttribute("href") || "", n: Array.from(document.querySelectorAll("#reviews-list a.rvact")).indexOf(act) } : null;
    };
    document.addEventListener("focusin", track);
    loadOlderRuns().then(() => {
      document.removeEventListener("focusin", track);
      if (location.hash !== from || currentRoutine() !== routine || state.reviews.view !== "runs") return;
      const a = document.activeElement;
      if (movedAway) {
        // The redraw dropped focus (to <body>) from an action link: back to the same one, the same position in the list.
        if (moved && (!a || a === document.body)) {
          const acts = Array.from(document.querySelectorAll<HTMLElement>("#reviews-list a.rvact")), m = moved as { href: string; n: number };
          (acts[m.n]?.getAttribute("href") === m.href ? acts[m.n] : acts.find((x) => x.getAttribute("href") === m.href))?.focus({ preventScroll: true });
        }
        return;
      }
      if (a && a !== document.body && !a.closest("[data-rv-older]")) return;
      (document.querySelector<HTMLElement>("[data-rv-older]") ?? Array.from(document.querySelectorAll<HTMLElement>("#reviews-list .rvrun a.row")).pop())?.focus({ preventScroll: true });
    });
  }
});
wireKeys();
// A pin toggled (a page's Pin, or p): every list's Pinned group, and the page's toggle.
wirePins(() => { invalidateTabs(); renderAll(); });
// What the item page changed in its row (seen, assigned, asked, decided, snoozed): every list rebuilds when next shown,
// and the one beside the item (the split view) now.
whenRowsChange(() => {
  invalidateTabs();
  if (state.route.view === "item" && isSplit(state.layout)) showTab(state.tab, true);
});
watchLayout();
route(true);
renderAll();
boot();
