import { $, announce, esc } from "../lib/dom.ts";
import { goUp, navigate } from "../lib/backnav.ts";
import { SHORTCUTS, keyAction, settling, type KeyAction, type KeyView } from "../lib/keys.ts";
import { orchHref } from "../lib/items.ts";
import { isSplit } from "../lib/layout.ts";
import { stepRow } from "../lib/nav.ts";
import { routeHref } from "../lib/reviews.ts";
import { currentRoutine } from "./reviews.ts";
import { setReviewsView, state } from "../state.ts";
import { focusHistorySearch, renderReviews } from "./index.ts";
import { closeSnoozeMenu, moreOpen, openMore } from "./item.ts";
import { pinFromKey } from "./pins.ts";

/* ---------- keyboard shortcuts and the ? overlay ---------- */
function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  // Buttons, checkboxes and radios take no text; every other input does.
  return el instanceof HTMLInputElement && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test(el.type);
}

function keyView(): KeyView {
  const v = state.route.view;
  return v === "tab" ? "index" : v === "item" ? "item" : (v === "orch" || v === "run" || v === "pr") && isSplit(state.layout) ? "orch" : "other";
}

// A group per section (three columns from 1100px). "j / →" reads "j or →", "g i" reads "g then i".
function helpHtml(): string {
  const keys = (spec: string) => spec.split("|").map((alt) =>
    alt.split(" ").map((step) => step.split("+").map((k) => "<kbd>" + esc(k) + "</kbd>").join("+")).join('<span class="vh"> then </span>'))
    .join('<span class="ksep" aria-hidden="true">/</span><span class="vh"> or </span>');
  return SHORTCUTS.map((g, i) => '<section aria-labelledby="keys-g' + i + '"><h3 class="slabel" id="keys-g' + i + '">' + esc(g.group) + '</h3><dl class="keys">' +
    g.rows.map(([k, what]) => "<dt>" + keys(k) + "</dt><dd>" + esc(what) + "</dd>").join("") + "</dl></section>").join("") +
    '<p class="knote">After each decision the keys pause for a moment, so a held key can\'t decide the next item. Hints hide on touch screens.</p>';
}

function toggleHelp(): void {
  const d = $<HTMLDialogElement>("key-help");
  if (d.open) { d.close(); return; }
  const body = $("key-help-body");
  if (!body.innerHTML) body.innerHTML = helpHtml();
  d.showModal();
}

// A visible, enabled control (the decide form hides the override box until it's opened; below 1100px the Q&A and
// snooze controls are in the More sheet, so not visible until it opens).
function usable(id: string): HTMLButtonElement | null {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  return el && !el.disabled && el.getClientRects().length ? el : null;
}

// The control a key opened the More sheet from: the focused one on the item page (its pager and back link
// included), else More.
function keyOpener(): string {
  const a = document.activeElement;
  return a instanceof HTMLElement && a.id && a.closest("#detail-view") ? a.id : "more-btn";
}

function follow(id: string): void {
  const a = document.getElementById(id);
  if (a instanceof HTMLAnchorElement) navigate(a.hash);
}

// Steps from the focused row, or from the remembered cursor when a re-render (live update, coming
// back to the tab or from an item) has dropped focus, so j never jumps to the top nor k to the bottom.
// The shown tab's rows, kept until its list changes: a key press on a 2,000-row History doesn't re-query them all.
// Any change under the index view (a re-render, Load older's rows, the Snoozed group opening) drops the cache.
let rowCache: { tab: string; rows: HTMLAnchorElement[]; hrefs: string[] } | null = null;
let rowWatch: MutationObserver | null = null;
function listRows(): { rows: HTMLAnchorElement[]; hrefs: string[] } {
  if (rowCache && rowCache.tab === state.tab) return rowCache;
  if (!rowWatch) {
    rowWatch = new MutationObserver(() => { rowCache = null; });
    rowWatch.observe($("index-view"), { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  }
  // Not the rows of a collapsed group (Snoozed): they stay in the DOM, and focusing them does nothing.
  const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>("#view-" + state.tab + " a.row")).filter((r) => !r.closest("details:not([open])"));
  rowCache = { tab: state.tab, rows, hrefs: rows.map((r) => r.getAttribute("href") || "") };
  return rowCache;
}

function moveRow(step: 1 | -1): void {
  const { rows, hrefs } = listRows(), i = rows.indexOf(document.activeElement as HTMLAnchorElement);
  const to = stepRow(hrefs, i >= 0 ? hrefs[i] : state.rowCursor[state.tab], step);
  const next = to == null ? undefined : rows[hrefs.indexOf(to)];
  if (!next) return;
  state.rowCursor[state.tab] = to;
  next.focus(); next.scrollIntoView({ block: "nearest" });
}

// j / k on an orchestrator, run or PR page beside its list (the split view): on to the row above or below it, as the
// pager steps through items. The list's ends stop it, and so does a page whose row isn't in the list shown (a PR
// opened from a run, beside Runs).
function stepPane(step: 1 | -1): void {
  const r = state.route, here = r.view === "orch" ? orchHref(r.id) : routeHref(r, currentRoutine());
  const { hrefs } = listRows();
  if (!here || !hrefs.includes(here)) return;
  const to = stepRow(hrefs, here, step);
  if (to && to !== here) navigate(to);
}

// v: Reviews' other view (Runs or PRs), from its list or a page beside it.
function toggleReviews(): void {
  if (state.tab !== "reviews" || (state.route.view !== "tab" && !isSplit(state.layout))) return;
  if (!document.querySelector("#reviews-seg [data-rvview]")) return; // not loaded yet
  // Focus on a row or on Runs | PRs is on what the redraw replaces: it moves to the row of the page open beside the
  // list when the new view has it, else to the button now checked. Focus anywhere else stays where it was.
  const a = document.activeElement, inList = a instanceof HTMLElement && !!a.closest("#reviews-seg, #reviews-list");
  setReviewsView(state.reviews.view === "runs" ? "prs" : "runs");
  renderReviews();
  if (inList && !document.activeElement?.closest("#reviews-seg, #reviews-list")) {
    // Not the open page's row inside a folded group (Mine, Bots): it's in the DOM, and focusing it does nothing.
    (Array.from(document.querySelectorAll<HTMLElement>("#reviews-list a.row[aria-current]")).find((r) => !r.closest("details:not([open])")) ?? document.querySelector<HTMLElement>('#reviews-seg [data-rvview="' + state.reviews.view + '"]'))?.focus();
  }
  announce(state.reviews.view === "runs" ? "Showing runs" : "Showing PRs");
}

function perform(a: KeyAction): void {
  switch (a.type) {
    case "help": toggleHelp(); return;
    case "blur": (document.activeElement as HTMLElement | null)?.blur(); return;
    case "go": navigate("#" + a.to); return;
    case "next": if (state.route.view === "item") follow("pager-next"); else stepPane(1); return;
    case "prev": if (state.route.view === "item") follow("pager-prev"); else stepPane(-1); return;
    case "toggle": toggleReviews(); return;
    case "back": if (!closeSnoozeMenu()) goUp($<HTMLAnchorElement>("back-link")); return;
    case "rowNext": moveRow(1); return;
    case "rowPrev": moveRow(-1); return;
    case "choose": {
      const b = document.querySelectorAll<HTMLButtonElement>("#choices .choice")[a.n - 1];
      if (b && !b.disabled) { b.click(); if (b.dataset.choice !== "other") b.focus(); }
      return;
    }
    case "submit": {
      // From the question box this sends the question; anywhere else it submits the decision (on phones the
      // bottom bar's Submit is the one shown).
      const ask = document.activeElement && document.activeElement.id === "ask-field";
      (ask ? usable("ask-send") : usable("submit-btn") || usable("pager-submit"))?.click();
      return;
    }
    case "ask": {
      // Below 1100px the thread is in the More sheet: open it there.
      const field = () => { const f = document.getElementById("ask-field"); return f && f.getClientRects().length ? f : null; };
      // Only where there is a question box (not for viewers).
      if (!usable("ask-open") && !field() && (document.getElementById("ask-open") || document.getElementById("ask-field"))) openMore("qa", keyOpener());
      usable("ask-open")?.click();
      const f = field();
      if (f) { f.focus(); f.scrollIntoView({ block: "center" }); }
      return;
    }
    case "note": {
      // An open decision's note: on a phone it may be folded behind "Add a note…", which opens and focuses it.
      if (!document.querySelector("#decide-form.ask")) return;
      const toggle = usable("note-toggle");
      if (toggle) { toggle.click(); return; }
      const f = document.getElementById("note-field") as HTMLTextAreaElement | null;
      if (f && !f.disabled && f.getClientRects().length) { f.focus(); f.scrollIntoView({ block: "nearest" }); }
      return;
    }
    case "accept": usable("ack-btn")?.click(); return;
    case "override": usable("ovr-btn")?.click(); return;
    case "snooze": {
      // From 1100px the presets are in the aside: s goes to the first ("1 hour").
      if (state.layout === "desk") {
        const p = document.querySelector<HTMLButtonElement>("#snooze-menu [data-snooze]");
        if (p && !p.disabled) { p.focus(); p.scrollIntoView({ block: "nearest" }); }
        return;
      }
      // Only where there is a snooze control (none for viewers, tokens or closed items).
      if (!usable("snooze-btn") && document.getElementById("snooze-btn") && !document.querySelector("#snooze-menu [data-snooze]")?.getClientRects().length) openMore("snooze", keyOpener());
      usable("snooze-btn")?.click();
      return;
    }
    case "search": focusHistorySearch(); return;
    case "pin": pinFromKey(currentRoutine()); return;
    case "g": return;
  }
}

let pendingG = 0;
export function wireKeys(): void {
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented) return;
    const help = $<HTMLDialogElement>("key-help");
    if (help.open) { if (ev.key === "?") { ev.preventDefault(); help.close(); } return; } // the dialog handles Esc
    const el = document.activeElement;
    // The More sheet takes the keys while it's open: Esc closes it (the dialog's own), not the item. Only
    // Ctrl/⌘+Enter from its question box still sends the question.
    if (moreOpen()) {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key === "Enter" && el && el.id === "ask-field") { ev.preventDefault(); usable("ask-send")?.click(); }
      return;
    }
    const a = keyAction(ev, {
      view: keyView(), typing: isTyping(el), pendingG: Date.now() - pendingG < 1200,
      // Enter submits from the checked option only; on another one its native Enter picks it (as Space does).
      onChoice: !!(el instanceof HTMLElement && el.closest("#choices .choice[aria-checked='true']")),
      sendField: !!el && (el.id === "note-field" || el.id === "ask-field"),
      settling: settling(state.advancedAt, Date.now()),
    });
    pendingG = a && a.type === "g" ? Date.now() : 0;
    if (!a) return;
    ev.preventDefault();
    perform(a);
  });
  document.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("[data-key-help]")) toggleHelp();
  });
  $("key-help-close").addEventListener("click", () => { $<HTMLDialogElement>("key-help").close(); });
  // A click on the backdrop (outside the panel) closes it too.
  $("key-help").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) $<HTMLDialogElement>("key-help").close(); });
}
