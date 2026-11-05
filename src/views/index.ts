import { $, esc, safeUrl, toast } from "../lib/dom.ts";
import {
  HISTORY_FILTERS, HISTORY_FILTER_LABEL, appendedRows, dayRuns, filterHistory, historyTotal, isHistoryFilter, serverMatches, wantsServerSearch, type HistoryFilter,
} from "../lib/history.ts";
import {
  ASSIGNEE_FILTERS, PRIO_LABEL, assigneesInUse, filterAssignee, flattenItem, fyiItems, headlineOf, isAsk, isAssigneeFilter, isAuto, isOpen, itemHref, openItems, orchHref,
  pastItems, prioOf, snoozedItems, sortedOrchs, type AssigneeFilter, type ItemRow, type OrchRow,
} from "../lib/items.ts";
import { isSplit } from "../lib/layout.ts";
import { pinHistory, pinInbox, pinKey, splitPinned } from "../lib/pins.ts";
import { StaleTabs } from "../lib/tabs.ts";
import { dayKey, dayLabel, relSpan } from "../lib/time.ts";
import { ApiError, store } from "../store.ts";
import { TABS, applyOlderPage, applySnooze, inboxItems, myEmail, scheduleZone, setAssigneeFilter, state, type Tab } from "../state.ts";
import { renderBadge, renderNav } from "./header.ts";
import { commitItem, draftFor, refreshItem } from "./item.ts";
import { renderOrchPage } from "./orch.ts";
import { pinnedHead, pinnedItems } from "./pins.ts";
import { routeHref } from "../lib/reviews.ts";
import { CHAT_ICON, itemRow, orchBadge, wakeText } from "./rows.ts";
import { currentRoutine, loadReviews, reviewsCard, reviewsListHtml, reviewsPlaceholder, reviewsSeg, wireReviewFolds } from "./reviews.ts";
import { navigate } from "../lib/backnav.ts";

/* ---------- index lists ---------- */
// Only the shown tab's list is built (src/lib/tabs.ts); a hidden one is built when it's shown. Counts always update.
const lists = new StaleTabs<Tab>(TABS);
// The tab whose list is on screen: the tab shown, or from 700px the list beside an open item, orchestrator, run or PR
// (the split view, src/main.ts route()), which keeps updating live while it's open.
const listTab = (): Tab | null => {
  const v = state.route.view;
  return v === "tab" || (v !== "settings" && isSplit(state.layout)) ? state.tab : null;
};
const RENDER: Record<Tab, () => void> = { inbox: renderInbox, team: renderTeam, reviews: renderReviews, history: renderHistory };
// Showing a tab (src/main.ts route()): builds its list if a render skipped it while hidden, or when `force`d.
export function showTab(tab: Tab, force: boolean): void {
  if (lists.show(tab, force)) RENDER[tab]();
}
// A detail page opened: every tab's list rebuilds when next shown, as viewing an item changes its row.
export function invalidateTabs(): void { lists.markAll(); }

// Boot failed or the Access session ended: say so in place of the list.
function unavailable(what: string): string | null {
  if (state.signedOut && !state.loaded) return '<div class="empty"><strong>Signed out.</strong><span class="small">Reload to sign in again.</span></div>';
  if (state.loadError) return '<div class="empty"><strong>' + esc(what) + " couldn't load.</strong><span class=\"small\">" + esc(state.loadError) + '</span><button type="button" class="btn" data-retry>Try again</button></div>';
  return null;
}

// The HTML each list was last built from. Every write to a list goes through setRows (or drops its entry), so
// a live update that changes nothing in a list (most of them, for a long History) costs no DOM rebuild.
const built = new WeakMap<HTMLElement, string>();

// The row buttons whose focus a rebuild keeps (FYI rows' Looks good / Override…, the Snoozed group's Unsnooze).
const ROW_ACTIONS = ["ack", "ovr", "unsnooze"];
// Rebuilds a list unless it already shows this HTML (false then). Focus survives it, so a live update, the minute
// tick or a busy redraw keeps the ring: on the same row (the j/k cursor) or row button (by item id and action), else
// on that row's link (the item moved: an unsnoozed row), else on the next row, or the previous one at the end.
function setRows(list: HTMLElement, html: string): boolean {
  if (built.get(list) === html) return false;
  const el = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
  const action = el ? ROW_ACTIONS.find((a) => el.dataset[a]) : undefined;
  const sel = action && el ? "[data-" + action + '="' + CSS.escape(el.dataset[action] || "") + '"]' : null;
  // Not a collapsed group's rows (Snoozed): they stay in the DOM, and focusing them does nothing.
  const rows = (): HTMLAnchorElement[] => Array.from(list.querySelectorAll<HTMLAnchorElement>("a.row")).filter((r) => !r.closest("details:not([open])"));
  const before = el ? rows().map((a) => a.getAttribute("href")) : [];
  const own = el ? (el.matches("a.row") ? el : el.closest(".rowwrap")?.querySelector("a.row"))?.getAttribute("href") ?? null : null;
  list.innerHTML = html;
  built.set(list, html);
  markCurrentRow();
  if (!el) return true;
  const target = (sel && list.querySelector<HTMLElement>(sel)) || refocusRow(rows(), before, own);
  target?.focus({ preventScroll: true });
  return true;
}
function refocusRow(now: HTMLAnchorElement[], before: (string | null)[], own: string | null): HTMLAnchorElement | undefined {
  const at = (href: string | null) => now.find((a) => a.getAttribute("href") === href);
  if (own && at(own)) return at(own);
  const i = before.indexOf(own);
  if (i < 0) return undefined;
  for (let j = i + 1; j < before.length; j++) { const a = at(before[j]); if (a) return a; }
  for (let j = i - 1; j >= 0; j--) { const a = at(before[j]); if (a) return a; }
  return undefined;
}

// Back on a list from a detail page: focus returns to the row that was opened (or paged to), the j/k
// cursor. A row that has left the list (just decided) leaves focus where it is.
export function focusCursorRow(tab: Tab): void {
  const href = state.rowCursor[tab]; if (!href) return;
  Array.from(document.querySelectorAll<HTMLAnchorElement>("#view-" + tab + " a.row")).find((a) => a.getAttribute("href") === href)?.focus({ preventScroll: true });
}

// The split view's selected row: aria-current="true" on the open item's or orchestrator's row (a DOM attribute, not part
// of the list's HTML, so moving between them doesn't rebuild the list). Beside an item opened from an orchestrator page,
// the Team list marks that orchestrator, where its back link leads. `reveal`: on a route change, scroll the list pane
// just enough to show it (not on a live re-render, which mustn't move the list under the viewer).
export function markCurrentRow(reveal = false): void {
  const r = state.route, back = $<HTMLAnchorElement>("back-link");
  const href = !isSplit(state.layout) ? null : r.view === "orch" ? orchHref(r.id) : r.view === "run" || r.view === "pr" ? routeHref(r, currentRoutine())
    : r.view !== "item" ? null : state.tab !== "team" ? itemHref(r.id) : back.hash.startsWith("#orch") ? back.getAttribute("href") : null;
  // Only the shown tab's rows are looked through (History may hold thousands); a mark left elsewhere is cleared.
  const current = href ? Array.from(document.querySelectorAll<HTMLAnchorElement>("#view-" + state.tab + " a.row")).find((a) => a.getAttribute("href") === href) : undefined;
  document.querySelectorAll<HTMLAnchorElement>('#index-view a.row[aria-current]').forEach((a) => { if (a !== current) a.removeAttribute("aria-current"); });
  if (current) current.setAttribute("aria-current", "true");
  if (reveal && current) revealInPane(current, $("index-view"));
}
// scrollIntoView({ block: "nearest" }) inside one scroller only: the page itself never scrolls in the split view.
function revealInPane(el: HTMLElement, pane: HTMLElement): void {
  const r = el.getBoundingClientRect(), p = pane.getBoundingClientRect(), pad = 8;
  if (r.top < p.top + pad) pane.scrollTop -= p.top + pad - r.top;
  else if (r.bottom > p.bottom - pad) pane.scrollTop += Math.min(r.bottom - p.bottom + pad, r.top - p.top - pad);
}
// From 700px, a list route's right pane: nothing selected yet. With asks waiting it offers the top one (j opens it
// too); with nothing waiting it says so. On Team it points at the list: an orchestrator's briefing opens here.
// Rebuilt only when what it says changes.
export function renderPlaceholder(): void {
  const box = $("split-empty");
  const asks = state.loaded ? openItems(inboxItems()) : [], tab = state.route.view === "tab" ? state.route.tab : null;
  const keys = '<p class="phkeys kbdonly"><kbd>j</kbd> <kbd>k</kbd> move in the list, <kbd>Enter</kbd> opens</p>';
  let h: string;
  if (tab === "reviews") h = reviewsPlaceholder(keys);
  else if (tab === "team") {
    h = '<div class="phbox"><p class="phtitle">Select a manager</p><p class="phtext">Its briefing opens here, beside the list.</p>' + keys + "</div>";
  } else if (state.loaded && !asks.length) {
    h = '<div class="phbox">' + CLEAR_ICON + '<p class="phtitle">All caught up</p><p class="phtext">Nothing needs your call. New asks open here.</p></div>';
  } else {
    h = '<div class="phbox"><p class="phtitle">Select an item</p><p class="phtext">It opens here, beside the list.</p>' +
      (asks.length ? '<a class="btn primary phgo" href="' + itemHref(asks[0].id) + '">Start with the top ask</a>' + keys : "") + "</div>";
  }
  if (box.dataset.sig !== h) { box.innerHTML = h; box.dataset.sig = h; }
}

/* ---------- Inbox filter: All / Mine / Unassigned ---------- */
const FILTER_LABEL: Record<AssigneeFilter, string> = { all: "All", mine: "Mine", unassigned: "Unassigned" };
// Shown to humans once assignees are in use (or a filter is saved), so a one-person inbox looks as it always did.
function filterShown(): boolean {
  return !!myEmail() && (state.assigneeFilter !== "all" || assigneesInUse(state.items, state.people));
}
function renderFilter(): void {
  const bar = $("inbox-filter");
  if (!state.loaded || !filterShown()) { bar.hidden = true; return; }
  const me = myEmail();
  const html = '<div class="seg" role="radiogroup" aria-label="Show items">' + ASSIGNEE_FILTERS.map((f) => {
    const n = openItems(filterAssignee(state.items, f, me)).length;
    return '<button type="button" role="radio" class="segbtn" data-afilter="' + f + '" aria-checked="' + (state.assigneeFilter === f) + '">' +
      FILTER_LABEL[f] + (n ? ' <span class="count">' + n + "</span>" : "") + "</button>";
  }).join("") + "</div>";
  if (bar.dataset.sig !== html) { bar.innerHTML = html; bar.dataset.sig = html; } // a focused button keeps focus across live renders
  bar.hidden = false;
}
export function wireInboxFilter(): void {
  document.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-afilter]");
    if (!b || !isAssigneeFilter(b.dataset.afilter)) return;
    setAssigneeFilter(b.dataset.afilter);
    renderInbox();
    refreshItem(); // beside the list (the split view): the item's place in the queue, prev / next and "Next: …" follow the filter
    (document.querySelector('#inbox-filter [data-afilter="' + b.dataset.afilter + '"]') as HTMLElement | null)?.focus();
  });
}

/* ---------- Snoozed: a collapsed group at the bottom of the Inbox, with Unsnooze on each row ---------- */
function snoozedGroup(snoozed: ItemRow[]): string {
  if (!snoozed.length) return "";
  return '<details class="snzgroup" id="snoozed-group"' + (state.snoozedOpen ? " open" : "") + ">" +
    '<summary><h3 class="ghead snzhead">Snoozed <span class="gn">' + snoozed.length + '</span><span class="caret" aria-hidden="true">&rsaquo;</span></h3></summary>' +
    snoozed.map((item) => itemRow(item, {
      snoozed: true,
      // Busy is aria-disabled, not disabled, so the button keeps focus while it saves.
      side: '<span class="rowside"><button type="button" class="btn snzwake" data-unsnooze="' + esc(item.id) + '"' + (state.busy.has(item.id) ? ' aria-disabled="true"' : "") +
        ' aria-label="Unsnooze: ' + esc(headlineOf(item)) + '">Unsnooze</button></span>',
    })).join("") + "</details>";
}
async function unsnoozeRow(id: string): Promise<void> {
  if (state.busy.has(id)) return;
  state.busy.add(id); renderInbox();
  try {
    const r = await store.snooze(id, null);
    applySnooze(r.item_id, r.until);
    toast("Back in your inbox");
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "unknown", String(e));
    toast(err.status === 403 ? "Only deciders can unsnooze." : "Couldn't unsnooze it. Try again.");
  } finally {
    state.busy.delete(id); renderInbox();
  }
}

const CLEAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.2 9.5"/></svg>';

export function renderInbox(): void {
  const list = $("inbox-list");
  const u = unavailable("The inbox"); if (u) { setRows(list, u); return; }
  if (!state.loaded) return;
  const now = Date.now(), scoped = inboxItems(), items = openItems(scoped, now);
  renderNav(); renderBadge(); renderPlaceholder();
  if (!lists.render("inbox", listTab())) return;
  renderFilter();
  const fyi = fyiItems(scoped, now), snoozed = snoozedItems(scoped, now);
  if (!items.length && !fyi.length && !snoozed.length && state.assigneeFilter !== "all") {
    setRows(list, '<div class="empty"><strong>' + (state.assigneeFilter === "mine" ? "Nothing assigned to you." : "Nothing unassigned.") + "</strong>" +
      '<button type="button" class="btn" data-afilter="all">Show all items</button></div>');
    return;
  }
  if (!items.length && !fyi.length) {
    // The header badge already says "Nothing needs you"; the panel says what lands here, and where to look next: the
    // snoozed items (when the next one wakes) and History.
    const wake = snoozed.length ? wakeText(snoozed[0].snoozed_until) : "";
    const acts = (snoozed.length ? '<button type="button" class="btn" data-show-snoozed aria-controls="snoozed-group" aria-expanded="' + state.snoozedOpen + '">Show snoozed</button>' : "") +
      (historyTotal(state.items, state.archive.total) ? '<a class="btn quiet" href="#history">See what was decided</a>' : "");
    if (setRows(list, '<div class="empty clear"><strong>' + CLEAR_ICON + 'Inbox clear.</strong><span class="small">' +
      (snoozed.length === 1 ? "Nothing needs you. One snoozed item wakes " + esc(wake) + "; it comes back here then, or when you unsnooze it."
        : snoozed.length ? "Nothing needs you. " + snoozed.length + " snoozed items come back here as their time comes; the next one wakes " + esc(wake) + "."
        : "Task proposals, decisions and blockers from the orchestrator land here. Each one you decide moves to History.") + "</span>" +
      (acts ? '<div class="clearacts">' + acts + "</div>" : "") + "</div>" + snoozedGroup(snoozed))) wireSnoozedGroup(list);
    return;
  }
  // The viewer's pinned asks and FYI items first, in their own group (src/lib/pins.ts).
  const pin = pinInbox(items, fyi, state.pins);
  let html = pin.pinned.length ? pinnedHead(pin.pinned.length) + pin.pinned.map((item) => itemRow(item, isAuto(item) ? { fyi: true } : {})).join("") : "", group: string | null = null;
  for (const item of pin.asks) {
    const p = prioOf(item);
    if (p !== group) {
      group = p;
      const n = pin.asks.filter((i) => prioOf(i) === p).length;
      html += '<h3 class="ghead ' + p + '">' + esc(PRIO_LABEL[p]) + ' <span class="gn">' + n + "</span></h3>";
    }
    html += itemRow(item);
  }
  if (pin.fyi.length) {
    html += '<h3 class="ghead fyi">FYI &middot; decided for you <span class="gn">' + pin.fyi.length + "</span></h3>";
    html += pin.fyi.map((item) => itemRow(item, { fyi: true })).join("");
  }
  if (setRows(list, html + snoozedGroup(snoozed))) wireSnoozedGroup(list);
}
function wireSnoozedGroup(list: HTMLElement): void {
  const g = list.querySelector<HTMLDetailsElement>("#snoozed-group");
  g?.addEventListener("toggle", () => {
    state.snoozedOpen = g.open;
    list.querySelector("[data-show-snoozed]")?.setAttribute("aria-expanded", String(g.open)); // Inbox clear's Show snoozed
  });
}
export function wireSnoozed(): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement, b = t.closest<HTMLButtonElement>("[data-unsnooze]");
    if (b && b.dataset.unsnooze && !busyButton(b)) unsnoozeRow(b.dataset.unsnooze);
    if (t.closest("[data-show-snoozed]")) showSnoozed();
  });
}
// Inbox clear's Show snoozed: the Snoozed group opens (and stays open), its first row focused.
function showSnoozed(): void {
  const g = document.querySelector<HTMLDetailsElement>("#snoozed-group"); if (!g) return;
  state.snoozedOpen = true; g.open = true;
  const first = g.querySelector<HTMLElement>("a.row") ?? g.querySelector<HTMLElement>("summary");
  first?.focus({ preventScroll: true });
  g.scrollIntoView({ block: "nearest" });
}

/* ---------- FYI rows: Looks good and Override… without opening the item ---------- */
const busyButton = (b: HTMLButtonElement): boolean => b.disabled || b.getAttribute("aria-disabled") === "true";
// Whatever shows FYI rows: the Inbox, History (the row moves there) and an orchestrator page's Auto-decided list.
function redrawRows(): void {
  renderInbox(); renderHistory();
  if (state.route.view === "orch") { state.shownSig = ""; renderOrchPage(state.route.id, $("detail")); }
}
export function wireFyiRows(): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement, ok = t.closest<HTMLButtonElement>("[data-ack]"), ovr = t.closest<HTMLButtonElement>("[data-ovr]");
    if (ok && ok.dataset.ack && !busyButton(ok)) commitItem(ok.dataset.ack, "accept", "", "Archived: looks good", redrawRows);
    // The item page, its override box open (src/views/item.ts autoForm).
    if (ovr && ovr.dataset.ovr && !busyButton(ovr)) {
      const id = ovr.dataset.ovr;
      draftFor(id).ovr = true;
      // Already open beside the list (the split view): no route change, so open its override note here.
      if (state.route.view === "item" && state.route.id === id) { refreshItem(); document.getElementById("note-field")?.focus(); }
      else navigate(itemHref(id));
    }
  });
}

export function renderTeam(): void {
  const list = $("team-list"), sum = $("team-sum");
  const u = unavailable("The team"); if (u) { sum.hidden = true; setRows(list, u); return; }
  if (!state.loaded) { sum.hidden = true; setRows(list, '<div class="empty">Loading the team…</div>'); return; }
  renderNav(); // the Team count: active orchestrators only
  if (!lists.render("team", listTab())) return;
  const os = sortedOrchs(state.orchestrators);
  if (!os.length) {
    sum.hidden = true;
    setRows(list, '<div class="empty"><strong>No managers yet.</strong><span class="small">When you approve a proposal, the orchestrator starts a session for it and it shows up here as O1, O2 and so on.</span></div>');
    return;
  }
  // "4 on the team", as the nav counts them (finished ones listed below the active, not counted).
  const active = os.filter((o) => o.status !== "done" && o.status !== "dropped" && o.status !== "cleaned").length, ended = os.length - active;
  const s = "<b>" + active + "</b> on the team" + (ended ? '<span class="tended"> · ' + ended + " finished</span>" : "");
  if (sum.innerHTML !== s) sum.innerHTML = s;
  sum.hidden = false;
  // The viewer's pinned orchestrators first, then the rest in status order.
  const pin = splitPinned(os, (o) => pinKey("orch", o.id), state.pins);
  setRows(list, (pin.pinned.length ? pinnedHead(pin.pinned.length) + pin.pinned.map(orchRow).join("") +
    (pin.rest.length ? '<h3 class="ghead">Rest of the team <span class="gn">' + pin.rest.length + "</span></h3>" : "") : "") + pin.rest.map(orchRow).join(""));
}
function orchRow(o: OrchRow): string {
  const open = state.items.filter((i) => i.orchestrator === o.id && isAsk(i)).length;
  const chat = safeUrl(o.session_url);
  // A grid like the item rows: the id large, the goal over one meta line (status, open asks, updated), a chevron.
  return '<div class="rowwrap"><a class="row orow" href="' + orchHref(o.id) + '">' +
    '<span class="oid">' + esc(o.id) + "</span>" +
    '<span class="rbody"><span class="rtitle">' + esc(o.goal || "(no goal)") + "</span>" +
    '<span class="ometa">' + orchBadge(o) +
    (open ? ' <span class="ocount" title="Open items">' + open + " open<span class=\"vh\"> item" + (open === 1 ? "" : "s") + "</span></span>" : "") +
    " " + relSpan(o.updated_at, true) + "</span></span>" +
    '<span class="chev" aria-hidden="true">&rsaquo;</span></a>' +
    (chat ? '<span class="rowside"><a class="iconlink" href="' + esc(chat) + '" target="_blank" rel="noopener" title="Open ' + esc(o.id) + ' chat" aria-label="Open ' + esc(o.id) + ' chat">' + CHAT_ICON + "</a></span>" : "") +
    "</div>";
}

/* ---------- Reviews: the routine card, Runs | PRs, then the run feed or the PR groups (src/views/reviews.ts) ---------- */
// The card and the toggle sit outside the list and are rebuilt only when they change, so a focused toggle keeps focus.
function setHtml(id: string, html: string): void {
  const el = $(id);
  if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  el.hidden = !html;
}
export function renderReviews(): void {
  const list = $("reviews-list");
  const u = unavailable("Reviews"); if (u) { setHtml("reviews-card", ""); setHtml("reviews-seg", ""); setRows(list, u); return; }
  if (!state.loaded) return;
  renderNav(); renderPlaceholder();
  if (!lists.render("reviews", listTab())) return;
  loadReviews(); // when the routine changed since it was loaded: renders again once it lands
  setHtml("reviews-card", reviewsCard());
  setHtml("reviews-seg", reviewsSeg());
  if (setRows(list, reviewsListHtml())) wireReviewFolds(list);
}

/* ---------- History: search box and quick filters above the list ---------- */
// The ids of the rows History last built (null: an empty or error state, or a server search's "Older matches"
// below them), so Load older can append to the list instead of rebuilding it.
let historyShown: string[] | null = null, historyFootShown = "";

export function renderHistory(): void {
  const list = $("history-list"), bar = $("history-bar");
  const u = unavailable("History"); if (u) { historyShown = null; bar.hidden = true; setRows(list, u); return; }
  if (!state.loaded) { historyShown = null; setRows(list, '<div class="empty">Loading history…</div>'); return; }
  // Archived items not loaded yet count too (the server's archived_total).
  const total = historyTotal(state.items, state.archive.total);
  renderNav();
  if (!lists.render("history", listTab())) return;
  historyShown = null;
  bar.hidden = !total;
  if (!total) { setRows(list, '<div class="empty"><strong>No decisions yet.</strong><span class="small">Items you decide, and items the orchestrator archives, are kept here newest first.</span></div>'); return; }
  document.querySelectorAll<HTMLElement>("#history-filters [data-hfilter]").forEach((b) => { b.setAttribute("aria-checked", String(b.dataset.hfilter === state.historyFilter)); });
  const q = state.historyQuery.trim(), me = myEmail();
  // The viewer's pinned past items on top (under the same search and filter), those beyond the loaded window fetched
  // on their own; the rest under their days.
  const pin = pinHistory(filterHistory(pastItems(state.items), q, state.historyFilter, me),
    filterHistory(pinnedItems().filter((i) => !isOpen(i)), q, state.historyFilter, me), state.pins), shown = pin.rest;
  // Older archived items the server's search found (not loaded here): after the local matches, under their own heading.
  const hs = state.historySearch, searching = wantsServerSearch(q, state.archive.more);
  const older = searching ? serverMatches(hs.hits, new Set(state.items.map((i) => i.id).concat(pin.pinned.map((i) => i.id))), q, state.historyFilter, me) : [];
  const n = pin.pinned.length + shown.length + older.length;
  $("history-count").textContent = historyCount(n, searching && hs.more, total);
  const foot = historyFoot(searching);
  if (!n) {
    if (searching && hs.loading) { setRows(list, foot); return; }
    const what = state.historyFilter === "all" ? "" : " in " + HISTORY_FILTER_LABEL[state.historyFilter];
    setRows(list, '<div class="empty"><strong>' + (q ? "Nothing matches “" + esc(q) + "”" + esc(what) + "." : "Nothing" + esc(what) + " yet.") + "</strong>" +
      '<span class="small">' + (q ? "Search looks in titles, summaries, questions, decision notes and manager ids." : HISTORY_EMPTY[state.historyFilter]) + "</span>" +
      '<button type="button" class="btn" data-hclear>' + (q && state.historyFilter !== "all" ? "Clear search and filter" : q ? "Clear search" : "Show all") + "</button></div>" + foot);
    return;
  }
  setRows(list, (pin.pinned.length ? pinnedHead(pin.pinned.length) + pin.pinned.map((item) => itemRow(item, { past: true })).join("") : "") + historyRows(shown) +
    (older.length ? '<h3 class="ghead srvhead" id="history-older">Older matches <span class="gn">' + older.length + (hs.more ? "+" : "") + "</span></h3>" +
      older.map((item) => itemRow(item, { past: true, server: true })).join("") : "") + foot);
  if (!older.length) { historyShown = shown.map((i) => i.id); historyFootShown = foot; }
}
// The day a History row sorts by (its decision, else its last update), in the zone `tz`.
const historyDay = (i: ItemRow, tz: string): string => dayKey(i.decision?.decided_at || i.updated_at, tz);
// The calendar day History's labels were last built on (Today and Yesterday move at midnight: see refreshHistoryDays).
let historyToday = "";
// History's rows under day headers (Today, Yesterday, Mon 5 Oct), each with its time of day. `after`: the day of the
// last row already shown, when these go below it (Load older), so that day isn't headed twice. Headers aren't rows.
// The zone is looked up once here, not per row.
function historyRows(rows: ItemRow[], after: string | null = null): string {
  const tz = scheduleZone(), now = Date.now();
  historyToday = dayKey(now, tz);
  return dayRuns(rows, (i) => historyDay(i, tz), after).map((run) =>
    (run.head ? '<h3 class="ghead day">' + esc(dayLabel(run.day, tz, now)) + "</h3>" : "") +
    run.rows.map((item) => itemRow(item, { past: true, clock: tz })).join("")).join("");
}
// The minute timer (src/main.ts): once the calendar day changes in the schedule's zone, History's Today and Yesterday
// are someone else's, so it rebuilds (now if shown, else when next shown), offline too.
export function refreshHistoryDays(): void {
  if (historyToday && dayKey(Date.now(), scheduleZone()) !== historyToday) renderHistory();
}
// "12 items", or with a search or filter "3 of 12" ("3+ of 12" while the server has more hits).
function historyCount(n: number, more: boolean, total: number): string {
  const filtered = !!state.historyQuery.trim() || state.historyFilter !== "all";
  return filtered ? n + (more ? "+" : "") + " of " + total : total + (total === 1 ? " item" : " items");
}
// Under the list: the server search's progress, and Load older while archived items remain on the server.
function historyFoot(searching: boolean): string {
  const hs = state.historySearch, a = state.archive;
  let h = "";
  if (searching && hs.loading) h += '<p class="hnote small" role="status" data-hfoot>Searching older items…</p>';
  else if (searching && hs.failed) h += '<p class="hnote small" role="status" data-hfoot>Couldn\'t search older items.</p>';
  if (a.more) {
    const left = Math.max(0, a.total - state.items.filter((i) => i.status === "archived").length);
    h += '<div class="hmore" data-hfoot><button type="button" class="btn" data-load-older' + (a.loading ? " disabled" : "") + ">" +
      (a.loading ? "Loading…" : "Load older" + (left ? ' <span class="mono">' + left + "</span>" : "")) + "</button></div>";
  }
  return h;
}
// Replaces the foot under History's rows (Load older's Loading… state), `rows` going in above it, without rebuilding
// the rows already there. False when History isn't showing rows of its own (no search on) to keep.
function swapHistoryFoot(rows = ""): boolean {
  if (!historyShown || state.historyQuery.trim() || listTab() !== "history") return false;
  const list = $("history-list"), foot = historyFoot(false), was = built.get(list);
  list.querySelectorAll("[data-hfoot]").forEach((el) => el.remove());
  list.insertAdjacentHTML("beforeend", rows + foot);
  // What the list now shows, as setRows would have built it, so the next live render can still skip.
  if (was !== undefined && was.endsWith(historyFootShown)) built.set(list, was.slice(0, was.length - historyFootShown.length) + rows + foot);
  else built.delete(list);
  historyFootShown = foot;
  return true;
}
// After Load older: the page's rows go at the end of the list when that's where they sort (no search on, no row
// sorting in among the shown ones, none changed); otherwise the list rebuilds.
function appendOlder(replaced: boolean): void {
  if (replaced || !historyShown || state.historyQuery.trim() || listTab() !== "history") { renderHistory(); return; }
  const f = state.historyFilter, me = myEmail();
  // The Pinned group above stays as it is; the rows below it are what can grow.
  const pin = pinHistory(filterHistory(pastItems(state.items), "", f, me), filterHistory(pinnedItems().filter((i) => !isOpen(i)), "", f, me), state.pins), shown = pin.rest;
  const add = appendedRows(historyShown, shown);
  if (!add) { renderHistory(); return; }
  const total = historyTotal(state.items, state.archive.total);
  renderNav();
  $("history-count").textContent = historyCount(pin.pinned.length + shown.length, false, total);
  // The row above the new ones: its day's header is already on screen.
  const last = historyShown.length ? shown[historyShown.length - 1] : undefined;
  swapHistoryFoot(historyRows(add, last ? historyDay(last, scheduleZone()) : null));
  historyShown = shown.map((i) => i.id);
}

const OLDER_PAGE = 100;
async function loadOlder(): Promise<void> {
  const a = state.archive;
  if (a.loading || !a.more) return;
  a.loading = true;
  if (!swapHistoryFoot()) renderHistory();
  let replaced = false;
  try {
    const params: Record<string, string | number> = { status: "archived", limit: OLDER_PAGE };
    if (a.cursor) { params.before = a.cursor.at; params.before_id = a.cursor.id; }
    const r = await store.listItems(params);
    // A page item already loaded (a live update raced it) may change a shown row: the list rebuilds then.
    replaced = r.items.some((d) => state.docs.has(d.id));
    applyOlderPage(r.items, !!r.more);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast("Couldn't load older items. Try again.");
  } finally {
    a.loading = false; appendOlder(replaced);
  }
}

// The server half of History's search: debounced with the local one; a newer query aborts the request in flight.
const SEARCH_LIMIT = 50;
let searchCtrl: AbortController | null = null;
function searchServer(): void {
  const q = state.historyQuery.trim(), hs = state.historySearch;
  searchCtrl?.abort(); searchCtrl = null;
  if (!wantsServerSearch(q, state.archive.more)) {
    if (hs.loading || hs.hits.length || hs.failed) { Object.assign(hs, { q: "", hits: [], more: false, loading: false, failed: false }); renderHistory(); }
    return;
  }
  const ctrl = new AbortController(); searchCtrl = ctrl;
  // The last query's hits stay meanwhile: serverMatches filters them by the current query.
  Object.assign(hs, { q, loading: true, failed: false }); renderHistory();
  store.listItems({ status: "archived", q, limit: SEARCH_LIMIT }, ctrl.signal).then((r) => {
    if (searchCtrl !== ctrl) return;
    hs.hits = r.items.map((d) => flattenItem(d)); hs.more = !!r.more;
    for (const row of hs.hits) if (!state.docs.has(row.id)) state.extra.set(row.id, row); // its page opens without a fetch
  }, (e) => {
    if (searchCtrl === ctrl && !(e instanceof DOMException && e.name === "AbortError")) { hs.failed = true; hs.hits = []; }
  }).finally(() => {
    if (searchCtrl !== ctrl) return;
    searchCtrl = null; hs.loading = false; renderHistory();
  });
}
const HISTORY_EMPTY: Record<HistoryFilter, string> = {
  all: "",
  mine: "Decisions you make on this page show here. Taps on a notification's buttons don't count: they can't tell who tapped.",
  auto: "Calls an agent made for you, once you accept or override them.",
  overridden: "Auto-decided calls you overrode.",
};

let searchTimer: ReturnType<typeof setTimeout> | undefined;
export function wireHistory(): void {
  $("history-filters").innerHTML = HISTORY_FILTERS.map((f) =>
    '<button type="button" role="radio" class="hchip" data-hfilter="' + f + '" aria-checked="' + (f === state.historyFilter) + '">' + esc(HISTORY_FILTER_LABEL[f]) + "</button>").join("");
  const field = $<HTMLInputElement>("history-search");
  // Debounced: a fast typist re-filters once per pause, not once per key, over hundreds of rows.
  field.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.historyQuery = field.value; renderHistory(); searchServer(); }, 120);
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement, b = t.closest<HTMLElement>("[data-hfilter]");
    if (b && isHistoryFilter(b.dataset.hfilter)) { state.historyFilter = b.dataset.hfilter; renderHistory(); return; }
    if (t.closest("[data-hclear]")) {
      clearTimeout(searchTimer);
      field.value = ""; state.historyQuery = ""; state.historyFilter = "all"; searchServer(); renderHistory();
      field.focus();
      return;
    }
    if (t.closest("[data-load-older]")) {
      // The button is re-rendered as it loads; focus follows it (or the search box, once everything is loaded).
      loadOlder().then(() => (document.querySelector<HTMLElement>("[data-load-older]") ?? $("history-search")).focus({ preventScroll: true }));
    }
  });
}
// `/` from a list: History, its search focused (desktop; phones have no keyboard shortcuts).
export function focusHistorySearch(): void {
  const focus = () => { const f = $<HTMLInputElement>("history-search"); if (!f.closest("[hidden]")) { f.focus(); f.select(); } };
  if (state.route.view === "tab" && state.tab === "history") { focus(); return; }
  window.addEventListener("hashchange", focus, { once: true }); // after main.ts's route() has shown the tab
  navigate("#history");
}
