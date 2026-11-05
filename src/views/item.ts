import type { Doc, Item } from "../../shared/types.ts";
import { $, announce, esc, setLive, toast } from "../lib/dom.ts";
import {
  CONF_LABEL, PRIO_LABEL, TYPE_LABEL, agentChoice, answeredAt, assigneesInUse, baseOptions, decideConflict, decisionLabel, endedChoice, evidenceOf, flattenItem, headlineOf, isAnswered, isAuto, isOpen,
  isSnoozed, itemHref, labelFor, optionsFor, orchHref, personName, prChip, prioOf, pushNote, recOf, typeOf,
  type ItemRow, type OptionView, type OrchRow, type Rec,
} from "../lib/items.ts";
import { decisionPrint, effectiveChoice, progressView, recMoved, submitState, type SubmitState } from "../lib/decide.ts";
import { SETTLE_MS, keyHints, settling, type HintKind } from "../lib/keys.ts";
import { isSplit } from "../lib/layout.ts";
import { canAct } from "../lib/roles.ts";
import { md, plain } from "../lib/md.ts";
import { advanceTarget, neighbors, triageOrder } from "../lib/nav.ts";
import { pickupPhrase } from "../lib/sched.ts";
import { snoozePresets } from "../lib/snooze.ts";
import { absTime, relSpan } from "../lib/time.ts";
import { ApiError, store } from "../store.ts";
import {
  applyItem, applySnooze, inboxItems, itemById, markSeen, myEmail, myRole, orchById, scheduleZone, state, type AskDraft, type AssignDraft, type Draft, type QaMsg,
} from "../state.ts";
import { ASK_ICON, SNOOZE_ICON, assigneeBadge, chatButton, linksBlock, section, skeleton, wakeText } from "./rows.ts";
import { reviewChip } from "./reviews.ts";
import { pinKey } from "../lib/pins.ts";
import { pinButton, pinSig } from "./pins.ts";
import { replaceWith } from "../lib/backnav.ts";

function rerender(): void {
  if (state.route.view === "item") renderItemPage(state.route.id, $("detail"));
}

// GET /api/items/:id for an item page whose item isn't loaded. Once per id: a render on every live update must not
// refetch, and a 404 (deleted, or another orchestrator's for a scoped token) stays "gone".
function fetchItem(id: string): void {
  state.itemFetch.set(id, "loading");
  store.getItem(id).then((d) => {
    state.itemFetch.delete(id);
    if (!state.docs.has(id)) { state.extra.set(id, flattenItem(d)); state.versions.set(id, d.version); }
  }, (e) => {
    state.itemFetch.set(id, e instanceof ApiError && (e.status === 404 || e.status === 403) ? "missing" : "failed");
  }).finally(rerender);
}

const REC_MOVED = "The recommendation changed. Choose again.";
const ITEM_CHANGED = "This item changed while you were on it. Review the options and choose again.";

// From 1100px the secondary blocks sit on the page, in an aside beside the call; below it they're in the More sheet
// (index.html #more-sheet).
const inlineSecondary = (): boolean => state.layout === "desk";
// From 700px (the split view) the call (note, Submit, "Next: …") is the item pane's footer, pinned to its bottom: it
// renders last on the page, after the secondary blocks, and style.css keeps it in view (position: sticky).
const docked = (): boolean => isSplit(state.layout);

const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>';
const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const REV_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h11a4 4 0 0 1 0 8H9"/><path d="M7 6L4 9l3 3"/></svg>';
const ONEWAY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15M14 7l5 5-5 5"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const NEXT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 7l5 5-5 5"/></svg>';

// This page changed what an item's row shows (its answer seen, assigned, asked, decided, snoozed): src/main.ts
// redraws the list beside it (the split view). Live updates redraw it themselves (renderAll).
let onRows: (() => void) | null = null;
export function whenRowsChange(fn: () => void): void { onRows = fn; }
const rowsChanged = (): void => { onRows?.(); };
// The item page again, if what it shows changed (its place in the queue under a new Inbox filter, an override opened
// from its FYI row): the render signature decides.
export function refreshItem(): void { rerender(); }

// The queue an item's next is taken from, as the pager and "Next: …" show it (src/lib/nav.ts neighbors): the Inbox's
// order with its filter; for an item the filter hides (or one decided meanwhile) the order last seen while it was in
// it; else the item first, so next is the queue's head. advanceTarget on it goes where those said it would.
// The Inbox's order as its list shows it (the viewer's Pinned group first), and an item's place in it.
const inboxOrder = (): string[] => triageOrder(inboxItems(), Date.now(), state.pins);
const inboxNeighbors = (id: string) => neighbors(inboxItems(), id, state.navOrder, Date.now(), state.pins);
function queueOrder(id: string): string[] {
  const shown = inboxOrder();
  return shown.includes(id) ? shown : state.navOrder.includes(id) ? state.navOrder.slice() : [id, ...shown];
}

/* ---------- item show page ---------- */
// The page is the call (focusMain: where it stands, the question, options, Submit) plus the background
// (secondaryBlocks: Q&A, snooze, assignee, context, evidence, history), which renders into the More sheet below
// 1100px. From there it's the aside beside the call ("About this decision"), and the orchestrator's context opens the
// main column. Either way each block renders once, so its ids are unique.
export function renderItemPage(id: string, box: HTMLElement): void {
  if (!state.loaded) {
    if (state.shownSig !== "loading") { state.shownSig = "loading"; leaveMore(); box.innerHTML = skeleton(3); renderKeyBar("view"); }
    return;
  }
  const item = itemById(id);
  renderPager(id);
  renderPeek(item);
  // Snoozing is for a signed-in human (the endpoint is 403 for tokens).
  renderKeyBar(!item ? "view" : !canAct(myRole()) ? "view" : !isOpen(item) ? "closed" : isAuto(item) ? "auto" : "decide", !!myEmail());
  if (!item) {
    // Not loaded: an older archived item (the page holds only the most recent ones), or gone. Ask the server once.
    const f = state.itemFetch.get(id);
    if (f === undefined || f === "loading") {
      if (f === undefined) fetchItem(id);
      if (state.shownSig !== "fetching") { state.shownSig = "fetching"; leaveMore(); box.innerHTML = skeleton(3); }
      return;
    }
    if (state.shownSig === "gone:" + f) return;
    state.shownSig = "gone:" + f;
    leaveMore();
    box.innerHTML = f === "failed"
      ? '<div class="panel empty"><strong>This item couldn\'t load.</strong><span class="small">Check your connection and reload.</span><a class="btn" href="#inbox">Back to the inbox</a></div>'
      : '<div class="panel empty"><strong>This item isn\'t in the inbox any more.</strong><span class="small">The orchestrator may have removed it.</span><a class="btn" href="#inbox">Back to the inbox</a></div>';
    return;
  }
  const orch = orchById(item.orchestrator), qa = state.qa.id === id ? state.qa : null;
  // Crossing below 1100px from a preset in the aside (s puts focus there): the presets stay drawn, in the More sheet,
  // so focus can follow them there.
  const was = document.activeElement;
  if (!inlineSecondary() && was instanceof HTMLElement && was.matches(".dside #snooze-menu [data-snooze]")) state.snoozeMenu = id;
  if (qa && qa.loaded) {
    // An answer still marked new is seen now, past markSeen's throttle, unless this device's clock is behind the
    // server's (a look stamped before the answer wouldn't clear it, and would be written on every render).
    const dot = isAnswered(item, state.seen);
    markSeen(id, dot && Date.now() >= answeredAt(item));
    if (dot && !isAnswered(item, state.seen)) rowsChanged(); // its row's "Answered" goes
  }
  const sig = JSON.stringify([item, orch && [orch.session_url, orch.session_live, orch.goal, orch.motivation, orch.session_title], state.busy.has(id),
    qa && [qa.loaded, qa.failed, qa.msgs], state.asks.get(id) || null, pickupPhrase(state.schedule),
    state.assigns.get(id) || null, item.assignee ? personName(item.assignee, state.people) : null, myEmail(),
    assigneesInUse(state.items, state.people), pushNote(item.assignee, state.people), snoozeSig(item), scheduleZone(), myRole(),
    state.layout, positionSig(id), state.signedOut, !!state.drafts.get(id)?.ovr, pinSig(pinKey("item", id))]);
  if (sig === state.shownSig) { refreshSnoozeTimes(); return; }
  if (canDecide(item)) {
    const rec = recOf(item), print = decisionPrint(item.question, baseOptions(item).list, rec && rec.option, [item.title, item.summary, rec && rec.why, rec && rec.confidence]);
    let d = state.drafts.get(id), eff = effChoice(item, d || {});
    // The question or an option changed under the choice (even with the same option ids): a decide now would be
    // pinned to the new version, so the server's 409 wouldn't catch it. The choice goes, picked or pre-selected;
    // the note stays.
    if (d && d.seen !== undefined && d.seen !== print && eff) {
      d.choice = null; delete d.recShown; eff = undefined;
      state.itemStatus.set(id, { msg: ITEM_CHANGED, kind: "err" }); announce(ITEM_CHANGED);
    }
    d = draftFor(id); d.seen = print;
    // The recommendation changed while it was pre-selected: don't move the pre-selection under the viewer.
    if (recMoved(d, eff)) {
      d.choice = null; delete d.recShown;
      state.itemStatus.set(id, { msg: REC_MOVED, kind: "err" }); announce(REC_MOVED);
    } else if (eff && !(d && "choice" in d)) draftFor(id).recShown = eff;
  }
  const more = $("more-body");
  // Keep the viewer's focus and caret across a live re-render, on the page or in the More sheet.
  const active = document.activeElement as HTMLElement | null;
  const hadFocus = !!active && (box.contains(active) || more.contains(active)), focusAt = hadFocus ? focusKey(active, box, more) : null;
  let selS: number | null = null, selE: number | null = null;
  if (focusAt && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) {
    try { selS = active.selectionStart; selE = active.selectionEnd; } catch { /* no selection on this input type */ }
  }
  state.shownSig = sig;

  const main = focusMain(item, orch, qa), sec = secondaryBlocks(item, orch, qa), call = docked() && isOpen(item) ? callBlock(item) : "";
  if (inlineSecondary()) {
    leaveMore();
    // The call stays the article's last child: from 700px it's the pane's footer, across both columns.
    box.innerHTML = '<article class="show focus"><div class="dcols"><div class="dmain">' + ctxStrip(item, orch) + main + "</div>" +
      '<aside class="dside" aria-label="About this decision">' + sec + "</aside></div>" + call + "</article>";
  } else {
    box.innerHTML = '<article class="show focus">' + main + call + "</article>";
    // Signed out: the sheet stays shut and empty (renderDetail and onSignedOut closed it); the page keeps the call.
    if (state.signedOut) leaveMore(); else more.innerHTML = sec;
  }
  wireItem(item);
  if (hadFocus) {
    const el = focusAt && findFocusKey(focusAt);
    // Nothing to go back to (that control is gone, or wasn't one a rebuilt page has): the item's heading, not the body.
    if (!el) $("page-title").focus({ preventScroll: true });
    else {
      // Crossing below 1100px with focus in the aside (a question being typed, a preset): that control is in the More
      // sheet now, so the sheet opens with focus on it rather than dropping focus to the page.
      const moved = more.contains(el) && !moreOpen();
      if (moved) openMore(null, "more-btn");
      el.focus({ preventScroll: true });
      if (moved) el.scrollIntoView({ block: "nearest" });
      if (selS != null && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) { try { el.setSelectionRange(selS, selE); } catch { /* not a text field */ } }
    }
  }
}

// Where focus was, as something the rebuilt page has too (on the page or in the More sheet, whichever it moved to):
// the element's id; else its nearest ancestor with an id, and its place there among elements of its kind (a link by
// its href: an evidence link, the Context summary). None when that ancestor is the page or the sheet itself, whose
// blocks are ordered differently in the aside and the sheet.
interface FocusKey { id: string; sel?: string; n?: number }
function focusKey(el: HTMLElement, box: HTMLElement, more: HTMLElement): FocusKey | null {
  if (el.id) return { id: el.id };
  const host = el.parentElement?.closest<HTMLElement>("[id]");
  if (!host || host === box || host === more || !(box.contains(host) || more.contains(host))) return null;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") : null;
  const sel = el.tagName.toLowerCase() + (href ? '[href="' + CSS.escape(href) + '"]' : "");
  return { id: host.id, sel, n: Array.from(host.querySelectorAll(sel)).indexOf(el) };
}
function findFocusKey(k: FocusKey): HTMLElement | null {
  const host = document.getElementById(k.id);
  return !host || !k.sel ? host : host.querySelectorAll<HTMLElement>(k.sel)[k.n ?? 0] || null;
}

function wireItem(item: ItemRow): void {
  const open = isOpen(item), auto = isAuto(item);
  // A <details open> fires "toggle" once as it renders; only a real change is the viewer's choice.
  const remember = (el: HTMLElement | null, set: (open: boolean) => void) => {
    if (!(el instanceof HTMLDetailsElement)) return;
    let last = el.open;
    el.addEventListener("toggle", () => { if (el.open !== last) { last = el.open; set(el.open); } });
  };
  remember(document.getElementById("ctx-strip"), (o) => { state.ctxOpen = o; });
  remember(document.getElementById("ctx-doc"), (o) => { state.contextOpen = o; });
  document.querySelectorAll<HTMLElement>("#detail [data-more]").forEach((b) => {
    b.addEventListener("click", () => { openMore(b.dataset.more || null, b.id || "more-btn"); });
  });
  if (open && canAct(myRole())) { if (auto) wireAutoForm(item); else wireDecideForm(item); wireSnooze(item); }
  wireAsk(item);
  wireAssign(item);
}

// What the page shows of the item's place in the queue (the progress line, the footer's "Next: …"), for the render
// signature.
function positionSig(id: string): string {
  const n = inboxNeighbors(id), nx = n.next ? itemById(n.next) : null;
  return n.index + "/" + n.total + "/" + (nx ? nx.id + ":" + headlineOf(nx) : "");
}

function focusMain(item: ItemRow, orch: OrchRow | null, qa: typeof state.qa | null): string {
  const auto = isAuto(item), open = isOpen(item);
  const q = typeof item.question === "string" ? item.question.trim() : "";
  let h = itemHead(item, orch);
  // The title stays the page's heading (focused on arrival, main.ts); the question, when there is one, is the big line.
  h += '<h2 id="page-title" tabindex="-1"' + (q && !auto ? ' class="kicker"' : "") + ">" + esc(item.title || "(untitled)") + "</h2>";
  if (auto) {
    h += answeredLine(item, qa);
    h += autoBlock(item);
    if (item.command) h += commandBlock(item, orch);
    if (item.steps) h += stepsBlock(item.steps);
    if (item.cost_of_waiting) h += waitLine(item.cost_of_waiting);
    if (!(open && docked())) h += callBlock(item);
    return h;
  }
  if (q) h += '<p class="qtext">' + esc(q) + "</p>";
  if (item.summary) h += '<div class="md lead">' + md(item.summary) + "</div>";
  h += answeredLine(item, qa);
  if (item.command) h += commandBlock(item, orch);
  if (item.steps) h += stepsBlock(item.steps);
  if (item.cost_of_waiting) h += waitLine(item.cost_of_waiting);
  const rec = recOf(item);
  h += optionsBlock(item, open, rec);
  // A recommendation that names none of the shown options has no card to sit in, so it keeps its own block.
  if (rec && !recInOptions(item, open, rec)) {
    const body = '<div class="recblk"><div class="recline"><span class="rlabel">' + esc(labelFor(item, rec.option)) + "</span>" +
      '<span class="rec">' + esc(recText(rec)) + "</span></div>" + (rec.why ? '<div class="md">' + md(rec.why) + "</div>" : "") + "</div>";
    h += section("Recommendation", body, "recsec");
  }
  if (!(open && docked())) h += callBlock(item);
  return h;
}
// The call: the decide form (Looks good / Override… for an auto-decided item), or what was decided.
function callBlock(item: ItemRow): string {
  if (!isOpen(item)) return verdictBlock(item);
  return isAuto(item) ? autoForm(item) : decideForm(item);
}

// Progress through the queue: a segment per item up to 12, else one bar filled in 5% steps (src/lib/decide.ts).
function progressBar(index: number, total: number): string {
  const pv = progressView(index, total);
  if (!pv) return "";
  return pv.segs
    ? '<span class="psegs" aria-hidden="true">' + Array.from({ length: pv.segs }, (_, i) => '<span class="pseg' + (i === index ? " on" : i < index ? " past" : "") + '"></span>').join("") + "</span>"
    : '<span class="pbar" aria-hidden="true"><span class="pfill f' + pv.fill + '"></span></span>';
}

// Progress through the queue ("1 of 5" and its segments), then the meta line: priority, type, PR, snooze,
// assignee, source, age; on the right, below 1100px, the orchestrator's context and More (⋯) (from 1100px the context
// is the card above, and the rest is beside it).
function itemHead(item: ItemRow, orch: OrchRow | null): string {
  const t = typeOf(item), p = prioOf(item), n = inboxNeighbors(item.id), bar = progressBar(n.index, n.total);
  let h = '<div class="ihead">';
  // From 700px the pane's header (the pager) shows this instead.
  if (bar) h += '<div class="iprog">' + bar + '<span class="pcount"><b>' + (n.index + 1) + "</b> of " + n.total + "</span></div>";
  h += '<div class="smeta"><span class="mleft">' +
    '<span class="prio ' + p + '"><span class="pd ' + p + '"></span>' + esc(PRIO_LABEL[p]) + "</span>" +
    '<span class="tword ' + t + '">' + esc(TYPE_LABEL[t]) + "</span>" +
    prChip(item) + reviewChip(item) +
    (isSnoozed(item) ? '<span class="chip snzchip" title="Snoozed for you until ' + esc(absTime(item.snoozed_until)) + '">' + SNOOZE_ICON + "until " + esc(wakeText(item.snoozed_until)) + "</span>" : "") +
    (item.assignee ? '<span class="assn' + (item.assignee === myEmail() ? " me" : "") + '">' + assigneeBadge(item.assignee) + esc(assigneeName(item.assignee)) + "</span>" : "") +
    (item.source ? '<span class="src">from ' + esc(item.source) + "</span>" : "") +
    relSpan(item.created_at) + '</span><span class="mright">' + pinButton(pinKey("item", item.id), isOpen(item) ? "the Inbox" : "History");
  if (item.orchestrator && !inlineSecondary()) {
    const oid = item.orchestrator;
    h += '<button type="button" class="octx" id="ctx-btn" data-more="ctx" aria-label="' + esc(oid) + ' context: why and goal">' + esc(orchName(oid, orch)) + CHEV + "</button>";
  }
  if (!inlineSecondary() && !state.signedOut) {
    h += '<button type="button" class="iconlink morebtn" id="more-btn" data-more="" aria-haspopup="dialog" aria-controls="more-sheet" aria-label="More for this decision" title="Questions, snooze, assignee, context, evidence">' + MORE_ICON + "</button>";
  }
  return h + "</span></div></div>";
}

// "O3 change log": the orchestrator's id with its session title.
function orchName(oid: string, orch: OrchRow | null): string {
  const st = orch && orch.session_title ? String(orch.session_title) : "";
  return st ? (st.startsWith(oid) ? st : oid + " · " + st) : oid;
}

// "O3 answered your question": the latest reply is newer than the latest question. With the thread loaded only
// (§ the reply's text is shown); it opens the thread (the More sheet at Questions below 1100px).
function answeredLine(item: ItemRow, qa: typeof state.qa | null): string {
  if (isNaN(answeredAt(item)) || !qa || !qa.loaded) return "";
  const last = qa.msgs.filter((m) => m && typeof m.text === "string" && m.role !== "user").pop();
  if (!last) return "";
  return '<button type="button" class="ansline" id="answered-line" data-more="qa"><span class="adot" aria-hidden="true"></span>' +
    '<span class="atop"><b>' + esc(msgWho(last, item)) + " answered your question</b>" + relSpan(last.created_at) + "</span>" +
    '<span class="aprev">' + esc(plain(last.text)) + "</span>" + CHEV + "</button>";
}

// One command for the viewer to run: "! <command>" is what they paste into the session that asked (from a phone too),
// with the link to that session beside it.
function commandBlock(item: ItemRow, orch: OrchRow | null): string {
  const cmd = "! " + String(item.command).trim(), chat = chatButton(orch, "Open " + (item.orchestrator || "manager") + " chat");
  const body = '<div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy command">Copy</button><pre><code>' + esc(cmd) + "</code></pre></div>";
  return section("Run this", body + (chat ? '<div class="actions sec">' + chat + "</div>" : ""), "cmdsec");
}
// What the agent needs the viewer to do (commands, links), kept out of the context.
function stepsBlock(text: string): string {
  return section("Steps for you", '<div class="md">' + md(text) + "</div>", "stepsec");
}
function waitLine(text: string): string {
  return '<p class="wait">' + CLOCK_ICON + "<span><b>Cost of waiting</b> " + esc(text) + "</span></p>";
}

function recText(rec: Rec): string {
  return "Recommended" + (rec.confidence ? ", " + CONF_LABEL[rec.confidence].toLowerCase() : "");
}
function recInOptions(item: ItemRow, open: boolean, rec: Rec): boolean {
  const o = open ? optionsFor(item) : baseOptions(item);
  return !(!open && o.implied) && o.list.some((opt) => opt.id === rec.option);
}

// rec: set on the recommended option only. Its why sits in the card as plain text: options are buttons,
// which can't hold paragraphs or links (the Evidence block has the links).
function optionInner(opt: OptionView, rec: Rec | null, picked: boolean, key = 0): string {
  const tag = typeof opt.reversible === "boolean"
    ? (opt.reversible ? '<span class="rtag rev">' + REV_ICON + "Reversible</span>" : '<span class="rtag oneway">' + ONEWAY_ICON + "One-way</span>") : "";
  const badges = (picked ? '<span class="rec mine">Your call</span>' : "") + (rec ? '<span class="rec">' + esc(recText(rec)) + "</span>" : "");
  let h = '<span class="ctop"><span class="radio" aria-hidden="true"></span><span class="clabel">' + esc(opt.label || opt.id) + "</span>" +
    (opt.other ? '<span class="cneed">needs a note</span>' : "") + (badges ? "" : tag) +
    (key ? '<kbd class="khint" aria-hidden="true">' + key + "</kbd>" : "") + "</span>";
  if (badges) h += '<span class="cline">' + badges + tag + "</span>";
  if (opt.description) h += '<span class="cdesc' + (opt.other ? " odesc" : "") + '">' + esc(opt.description) + "</span>";
  if (opt.consequence) h += '<span class="cons"><b>Then</b> ' + esc(opt.consequence) + "</span>";
  if (opt.tradeoff) h += '<span class="trade"><b>Tradeoff</b> ' + esc(opt.tradeoff) + "</span>";
  const why = rec ? plain(rec.why) : "";
  if (why) h += '<span class="cwhy">' + esc(why) + "</span>";
  return h;
}
// Open items: tappable radio blocks (plus Other); the recommendation is pre-selected (src/lib/decide.ts).
// Closed items: the same blocks, read-only, with the choice marked.
function optionsBlock(item: ItemRow, open: boolean, rec: Rec | null): string {
  const recFor = (opt: OptionView) => (rec && opt.id === rec.option ? rec : null);
  let h: string;
  if (open) {
    const o = optionsFor(item), d = state.drafts.get(item.id) || {}, busy = state.busy.has(item.id) || !canAct(myRole()), eff = effChoice(item, d);
    h = '<section class="bk opts"><p class="slabel" id="choices-lbl">Options</p><div class="choices" id="choices" role="radiogroup" aria-labelledby="choices-lbl">';
    o.list.forEach((opt, i) => {
      const r = recFor(opt);
      const cls = "choice" + (opt.id === "reject" ? " reject" : "") + (opt.other ? " other" : "") + (r ? " is-rec" : "");
      h += '<button type="button" role="radio" id="choice-' + i + '" class="' + cls + '" data-choice="' + esc(opt.id) + '" aria-checked="' + (eff === opt.id) + '"' + (busy ? " disabled" : "") + ">" +
        optionInner(opt, r, false, i < 9 ? i + 1 : 0) + "</button>";
    });
    return h + "</div></section>";
  }
  const b = baseOptions(item);
  if (b.implied) return "";
  const chosen = item.decision && item.decision.choice;
  h = '<section class="bk opts"><p class="slabel">Options</p><div class="choices">';
  b.list.forEach((opt) => {
    const r = recFor(opt), picked = chosen === opt.id;
    h += '<div class="choice static' + (picked ? " picked" : "") + (r ? " is-rec" : "") + (opt.id === "reject" ? " reject" : "") + '">' + optionInner(opt, r, picked) + "</div>";
  });
  return h + "</div></section>";
}

/* ---------- the background: the More sheet's blocks (the aside from 1100px) ---------- */
// Ids are unique: these render in exactly one place at a time (renderItemPage). The aside leaves out the orchestrator's
// context (it opens the main column there) and puts Open chat in the Evidence heading.
function secondaryBlocks(item: ItemRow, orch: OrchRow | null, qa: typeof state.qa | null): string {
  const aside = inlineSecondary();
  let h = qaBlock(item, qa);
  if (isOpen(item) && canAct(myRole())) h += snoozeBlock(item);
  h += assigneeBlock(item);
  if (aside) return h + evidenceBlock(item, orch, true) + contextBlock(item) + timelineBlock(item);
  return h + ctxStrip(item, orch) + contextBlock(item) + evidenceBlock(item, orch, false) + timelineBlock(item);
}

// Evidence links, then Open chat; in the aside the chat sits in the heading's row when there are links.
function evidenceBlock(item: ItemRow, orch: OrchRow | null, aside: boolean): string {
  const lb = linksBlock(evidenceOf(item)), cb = item.orchestrator ? chatButton(orch, "Open " + item.orchestrator + " chat") : "";
  const chat = cb ? '<div class="actions sec">' + cb + "</div>" : "";
  if (!lb) return chat;
  if (aside && cb) return '<section class="bk sec" id="evidence"><div class="sechd"><h3 class="slabel">Evidence</h3>' + cb + "</div>" + lb + "</section>";
  return '<section class="bk sec" id="evidence"><h3 class="slabel">Evidence</h3>' + lb + "</section>" + chat;
}

// Context: collapsed on phones, open on wide screens unless toggled.
function contextBlock(item: ItemRow): string {
  if (!item.context) return "";
  const open = state.contextOpen ?? (typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches);
  return '<details class="fold ctxdoc sec" id="ctx-doc"' + (open ? " open" : "") + '><summary><span class="flbl">Context</span>' +
    '<span class="fprev" aria-hidden="true">' + esc(plain(item.context)) + '</span><span class="caret" aria-hidden="true">&rsaquo;</span></summary>' +
    '<div class="fbody md">' + md(item.context) + "</div></details>";
}

// The orchestrator's context: "O3 · Why: … · Goal: …"; expanded, Why + Goal and a link to the briefing.
// Open unless toggled: in the More sheet, and from 1100px at the top of the main column.
function ctxStrip(item: ItemRow, orch: OrchRow | null): string {
  if (!item.orchestrator) return "";
  const oid = item.orchestrator, why = orch ? plain(orch.motivation) : "", goal = orch && orch.goal, line: string[] = [];
  if (why) line.push("<b>Why:</b> " + esc(why));
  if (goal) line.push("<b>Goal:</b> " + esc(goal));
  if (!line.length) line.push(orch ? "No briefing yet" : "Not on the team list");
  const open = state.ctxOpen ?? true;
  let h = '<details class="ctx sec" id="ctx-strip"' + (open ? " open" : "") + "><summary>" +
    '<span class="oid">' + esc(oid) + '</span><span class="oname" title="' + esc(orchName(oid, orch)) + '">' + esc(orchName(oid, orch)) + '</span><span class="ctxline">&middot; ' + line.join(" &middot; ") + "</span>" +
    '<span class="caret" aria-hidden="true">&rsaquo;</span></summary><div class="ctxbody">';
  if (orch && orch.motivation) h += '<div class="bk"><p class="blabel">Why</p><div class="md">' + md(orch.motivation) + "</div></div>";
  if (goal) h += '<div class="bk"><p class="blabel">Goal</p><div class="md">' + esc(goal) + "</div></div>";
  h += '<div><a class="btn" href="' + orchHref(oid) + '">Open ' + esc(oid) + " briefing &rsaquo;</a></div></div></details>";
  return h;
}

/* ---------- the More sheet ---------- */
const SECTION: Record<string, string> = { qa: "qa", snooze: "snooze", assignee: "assignee", ctx: "ctx-strip", evidence: "evidence" };
let sheetWired = false;
let opener: { item: string; id: string } | null = null; // the control that opened the sheet, by id
function sheet(): HTMLDialogElement {
  const d = $<HTMLDialogElement>("more-sheet");
  if (!sheetWired) {
    sheetWired = true;
    $("more-close").addEventListener("click", () => { d.close(); });
    // A click on the backdrop (outside the panel) closes it too.
    d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
    // Esc closes an open Snooze menu first, as it does on the page.
    d.addEventListener("cancel", (ev) => { if (state.snoozeMenu) { ev.preventDefault(); closeSnoozeMenu(); } });
    d.addEventListener("close", () => {
      if (state.snoozeMenu) { state.snoozeMenu = null; rerender(); }
      // Back to the control that opened it, or its replacement after a live re-render (else More), while still on
      // that item, whatever the browser restored (a tap doesn't always focus a button).
      const o = opener; opener = null;
      if (o && state.route.view === "item" && state.route.id === o.item) {
        (document.getElementById(o.id) || document.getElementById("more-btn"))?.focus({ preventScroll: true });
      }
    });
  }
  return d;
}
// Opens the More sheet (below 1100px), scrolled to a section: "qa", "snooze", "assignee", "ctx", "evidence". From
// 1100px the blocks are on the page, so it scrolls there (and opens the context). false when there's no item page.
// openerId: the control that opened it (focus goes back there on close).
export function openMore(sectionName: string | null = null, openerId = "more-btn"): boolean {
  if (state.route.view !== "item" || state.signedOut || !document.getElementById("page-title")) return false;
  const target = sectionName && SECTION[sectionName] ? document.getElementById(SECTION[sectionName]) : null;
  if (target instanceof HTMLDetailsElement && !target.open) target.open = true;
  if (inlineSecondary()) { target?.scrollIntoView({ block: "start", behavior: "smooth" }); return !!target; }
  const d = sheet();
  if (!d.open) {
    opener = { item: state.route.id, id: openerId };
    d.showModal();
  }
  if (target) target.scrollIntoView({ block: "start" }); else d.scrollTop = 0;
  return true;
}
export function moreOpen(): boolean {
  return (document.getElementById("more-sheet") as HTMLDialogElement | null)?.open ?? false;
}
// Leaving the item (or showing another one, or replacing the page with sign-out or an error): the sheet closes and
// its blocks go. newPage: a different page, so its snooze message goes too.
export function leaveMore(newPage = false): void {
  if (newPage) snoozeStatus = null;
  const d = document.getElementById("more-sheet") as HTMLDialogElement | null;
  // Not back to what opened it: the sheet is going because the page changed under it (crossing to 1100px moves its
  // blocks, focus included, into the aside), and its close event comes after renderItemPage has placed focus.
  opener = null;
  if (d && d.open) d.close();
  const b = document.getElementById("more-body");
  if (b && b.innerHTML) b.innerHTML = "";
}

function autoBlock(item: ItemRow): string {
  const d = item.decision, ch = agentChoice(item);
  let h = '<section class="panel autodec"><p class="slabel">Decided for you</p>';
  h += '<div class="vbig">' + esc(ch ? labelFor(item, ch) : "No choice recorded") + "</div>";
  if (d && d.choice !== "override" && d.note) h += '<div class="vnote">' + esc(d.note) + "</div>";
  h += "</section>";
  if (item.summary) h += '<section class="bk"><p class="slabel">Reasoning</p><div class="md">' + md(item.summary) + "</div></section>";
  const alts = (Array.isArray(item.options) ? item.options : []).filter((o) => o && o.id && o.id !== ch);
  if (alts.length) {
    h += '<section class="bk"><p class="slabel">Alternatives</p><ul class="alts">' + alts.map((o) =>
      '<li><span class="alabel">' + esc(o.label || o.id) + "</span>" + (o.description ? '<span class="adesc">' + esc(o.description) + "</span>" : "") +
      (o.consequence ? '<span class="adesc"><b>Then</b> ' + esc(o.consequence) + "</span>" : "") + "</li>").join("") + "</ul></section>";
  }
  return h;
}

export function draftFor(id: string): Draft {
  let d = state.drafts.get(id);
  if (!d) { d = {}; state.drafts.set(id, d); }
  return d;
}
function statusLine(id: string): string {
  const st = state.itemStatus.get(id);
  // A 409's message is an alert, announced as the line is inserted with it; only the first time, so a later re-render
  // (a live update, the minute timer) doesn't announce it again.
  const alert = !!st?.alert;
  if (st) st.alert = false;
  return '<div class="status' + (st && st.kind ? " " + st.kind : "") + '" id="decide-status"' + (alert ? ' role="alert"' : "") + ">" + esc(st ? st.msg : "") + "</div>";
}

// A viewer's "Your call" panel: what they'd press, disabled, and why.
function viewOnlyForm(): string {
  return '<section class="panel decide" id="decide-form"><p class="slabel">Your call</p>' +
    '<button type="button" class="btn primary big" disabled aria-describedby="viewonly-note">Submit</button>' +
    '<p class="small-note" id="viewonly-note">View only: your role is viewer, so you can read this item but not decide it. An admin can make you a decider in Settings, People.</p></section>';
}

function autoForm(item: ItemRow): string {
  if (!canAct(myRole())) return viewOnlyForm();
  const d = state.drafts.get(item.id) || {}, busy = state.busy.has(item.id);
  let h = '<section class="panel decide auto" id="decide-form"><p class="slabel">Your call</p>';
  // Not live in the settle window after arriving (armSettle brings it back), like Submit.
  h += '<div class="actions split"><button type="button" class="btn primary" id="ack-btn"' + (busy || settling(state.advancedAt, Date.now()) ? " disabled" : "") + ">Looks good</button>" +
    '<button type="button" class="btn" id="ovr-btn" aria-expanded="' + !!d.ovr + '" aria-controls="ovr-box"' + (busy ? " disabled" : "") + ">Override…</button></div>";
  h += '<div class="decide" id="ovr-box"' + (d.ovr ? "" : " hidden") + ">";
  h += '<label class="notelbl" for="note-field"><span>What should happen instead?</span><span class="req on">required</span></label>';
  h += '<textarea class="note' + (!(d.note || "").trim() ? " need" : "") + '" id="note-field" maxlength="1500" placeholder="Tell the agent what to do instead, and why"' + (busy ? " disabled" : "") + ">" + esc(d.note || "") + "</textarea>";
  h += '<button type="button" class="btn primary big" id="submit-btn">' + esc(overrideLabel(item, d)) + "</button></div>";
  h += statusLine(item.id);
  return h + "</section>";
}
function overrideLabel(item: ItemRow, d: Draft): string {
  if (state.busy.has(item.id)) return "Saving…";
  return (d.note || "").trim() ? "Send override" : "Write a note to override";
}
function syncAutoForm(item: ItemRow): void {
  const d = state.drafts.get(item.id) || {}, btn = document.getElementById("submit-btn") as HTMLButtonElement | null; if (!btn) return;
  btn.textContent = overrideLabel(item, d);
  btn.disabled = state.busy.has(item.id) || !(d.note || "").trim();
  $("note-field").classList.toggle("need", !(d.note || "").trim());
}
function wireAutoForm(item: ItemRow): void {
  const id = item.id;
  $("ack-btn").addEventListener("click", () => { if (!settling(state.advancedAt, Date.now())) acceptAuto(id); });
  $("ovr-btn").addEventListener("click", () => {
    const d = draftFor(id); d.ovr = !d.ovr;
    $("ovr-box").hidden = !d.ovr; $("ovr-btn").setAttribute("aria-expanded", String(d.ovr));
    if (d.ovr) $("note-field").focus();
  });
  $<HTMLTextAreaElement>("note-field").addEventListener("input", (e) => { draftFor(id).note = (e.target as HTMLTextAreaElement).value; syncAutoForm(item); });
  $("submit-btn").addEventListener("click", () => { overrideAuto(id); });
  syncAutoForm(item);
}

/* ---------- the decision: the chosen option (or the pre-selected recommendation), the note, Submit ---------- */
function canDecide(item: ItemRow): boolean { return isOpen(item) && !isAuto(item) && canAct(myRole()); }
// The option the page treats as chosen: the viewer's pick, else the recommendation (src/lib/decide.ts).
function effChoice(item: ItemRow, d: Draft): string | undefined {
  const rec = recOf(item);
  return effectiveChoice(d, rec && rec.option, optionsFor(item).list.map((o) => o.id), canDecide(item));
}
// The phone's note opens on its own for Other…, a note already written, or when the viewer opened it.
function noteShown(d: Draft, eff: string | undefined): boolean {
  return state.layout !== "phone" || !!d.noteOpen || eff === "other" || !!(d.note || "").trim();
}

// The option blocks live above; this panel holds the note and the submit button (the phone's Submit is in the
// bottom bar, renderPager). From 700px it's the item pane's footer bar: the status line, then the note beside
// Submit, "Next: …" under it.
function decideForm(item: ItemRow): string {
  if (!canAct(myRole())) return viewOnlyForm();
  const d = state.drafts.get(item.id) || {}, busy = state.busy.has(item.id), eff = effChoice(item, d), shown = noteShown(d, eff);
  const needNote = eff === "other", bar = docked();
  let h = '<section class="panel decide ask' + (bar ? " callbar" : "") + '" id="decide-form"><p class="slabel">Your call</p>';
  if (bar) h += statusLine(item.id);
  if (state.layout === "phone") {
    h += '<button type="button" class="notetoggle" id="note-toggle" aria-expanded="' + shown + '" aria-controls="note-wrap"' + (shown ? " hidden" : "") + ">" +
      PLUS_ICON + "<span>Add a note for " + esc(item.orchestrator || "the orchestrator") + '</span><span class="opt">optional</span></button>';
  }
  h += '<div class="notewrap" id="note-wrap"' + (shown ? "" : " hidden") + ">";
  h += '<label class="notelbl" for="note-field"><span>Note</span><span class="req' + (needNote ? " on" : "") + '" id="note-req">' + (needNote ? "required for Other" : "optional") + "</span></label>";
  h += '<textarea class="note' + (needNote && !(d.note || "").trim() ? " need" : "") + '" id="note-field" maxlength="1500"' + (bar ? ' rows="1"' : "") +
    ' placeholder="' + esc(notePlaceholder(item, needNote)) + '"' + (busy ? " disabled" : "") + ">" + esc(d.note || "") + "</textarea></div>";
  const s = submitFor(item, d), hold = settling(state.advancedAt, Date.now());
  if (bar) h += '<div class="cbgo">';
  // The footer's Submit can be narrower than its label: the whole of it is its tooltip there.
  h += '<button type="button" class="btn primary big formsubmit" id="submit-btn" aria-describedby="submit-help' + (bar ? " call-next" : "") + '"' + (bar ? ' title="' + esc(s.label) + '"' : "") +
    (s.enabled && !hold ? "" : " disabled") + ">" + esc(s.label) + "</button>";
  h += '<p class="small-note shelp" id="submit-help"' + (s.help ? "" : " hidden") + ">" + esc(s.help) + "</p>";
  if (bar) h += '<p class="cbnext" id="call-next">' + nextLine(item.id, "Next: ") + "</p></div>";
  else h += statusLine(item.id);
  return h + "</section>";
}
function notePlaceholder(item: ItemRow, needNote: boolean): string {
  if (needNote) return "What should happen instead?";
  return docked() ? "Add a note for " + (item.orchestrator || "the orchestrator") + " (optional)" : "Context for the orchestrator (optional)";
}
// What deciding leads to: the next item in the queue ("Then next: …" in the phone's bar, "Next: …" in the footer).
function nextLine(id: string, lead: string): string {
  const n = inboxNeighbors(id), nx = n.next ? itemById(n.next) : null;
  return nx ? esc(lead) + "<b>" + esc(headlineOf(nx)) + "</b>" : "Then back to the inbox";
}
// One state for both Submit buttons: this form's and, on phones, the bottom bar's (renderPager).
function submitFor(item: ItemRow, d: Draft): SubmitState {
  const eff = effChoice(item, d);
  return submitState({ choice: eff, note: d.note }, state.busy.has(item.id), eff ? labelFor(item, eff) : "");
}
function canSubmit(item: ItemRow, d: Draft): boolean { return submitFor(item, d).enabled; }
function syncDecideForm(item: ItemRow): void {
  const d = state.drafts.get(item.id) || {}, btn = document.getElementById("submit-btn") as HTMLButtonElement | null;
  if (!btn) { renderPager(item.id); return; }
  const note = $<HTMLTextAreaElement>("note-field"), req = $("note-req"), help = $("submit-help"), s = submitFor(item, d), eff = effChoice(item, d);
  btn.textContent = s.label; btn.disabled = !s.enabled || settling(state.advancedAt, Date.now());
  if (docked()) btn.title = s.label;
  help.textContent = s.help; help.hidden = !s.help;
  renderPager(item.id);
  const needNote = eff === "other", shown = noteShown(d, eff);
  $("note-wrap").hidden = !shown;
  const tog = document.getElementById("note-toggle");
  if (tog) { tog.hidden = shown; tog.setAttribute("aria-expanded", String(shown)); }
  req.textContent = needNote ? "required for Other" : "optional"; req.classList.toggle("on", needNote);
  note.placeholder = notePlaceholder(item, needNote);
  note.classList.toggle("need", needNote && !(d.note || "").trim());
  document.querySelectorAll<HTMLElement>("#choices .choice").forEach((b) => { b.setAttribute("aria-checked", String(b.dataset.choice === eff)); });
}
function wireDecideForm(item: ItemRow): void {
  const id = item.id;
  document.querySelectorAll<HTMLElement>("#choices .choice").forEach((b) => {
    b.addEventListener("click", () => {
      draftFor(id).choice = b.dataset.choice; state.itemStatus.delete(id);
      const s = $("decide-status"); s.textContent = ""; s.className = "status"; s.removeAttribute("role"); // a 409's alert is over
      syncDecideForm(item);
      if (b.dataset.choice === "other") $("note-field").focus();
    });
  });
  document.getElementById("note-toggle")?.addEventListener("click", () => {
    draftFor(id).noteOpen = true; syncDecideForm(item); $("note-field").focus();
  });
  $<HTMLTextAreaElement>("note-field").addEventListener("input", (e) => { draftFor(id).note = (e.target as HTMLTextAreaElement).value; syncDecideForm(item); });
  // Not inside the settle window after an auto-advance: a second tap meant for the last item doesn't decide this one.
  $("submit-btn").addEventListener("click", () => { if (!settling(state.advancedAt, Date.now())) decide(id); });
  syncDecideForm(item);
}

// Submit shows disabled for the moment after an auto-advance (the settle window); this brings it back.
let settleTimer: ReturnType<typeof setTimeout> | undefined;
function armSettle(id: string): void {
  const left = SETTLE_MS - (Date.now() - state.advancedAt);
  if (left <= 0) return;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (state.route.view !== "item" || state.route.id !== id) return;
    const it = itemById(id), ack = document.getElementById("ack-btn") as HTMLButtonElement | null;
    if (ack) ack.disabled = state.busy.has(id) || settling(state.advancedAt, Date.now());
    if (it && canDecide(it) && document.getElementById("choices")) syncDecideForm(it); else renderPager(id);
  }, Math.min(left, SETTLE_MS) + 20);
}

function verdictBlock(item: ItemRow): string {
  const d = item.decision, processing = item.status === "processing";
  let h: string, head: string;
  if (isAuto(item)) {
    const ovr = d && d.choice === "override";
    head = processing ? "Being handled" : ovr ? "Overridden" : item.status === "archived" ? "Accepted" : "Closed";
    h = '<section class="panel verdict ' + (processing ? "processing" : ovr ? "override" : "accepted") + '"><p class="slabel vhead">' + head + "</p>";
    if (ovr && d) {
      h += '<div class="vline"><span class="vbig override">Overridden</span>' + (d.decided_at ? '<span class="rel" title="' + esc(absTime(d.decided_at)) + '">' + esc(absTime(d.decided_at)) + "</span>" : "") + "</div>";
      h += '<div class="vwas">The agent had chosen: ' + esc(item.override_of ? labelFor(item, item.override_of) : "unknown") + "</div>";
      if (d.note) h += '<div class="vnote">' + esc(d.note) + "</div>";
    } else h += '<div class="vnote">You confirmed this call' + (item.updated_at ? " on " + esc(absTime(item.updated_at)) : "") + ".</div>";
  } else {
    // Withdrawn by its asker, or closed by the GitHub hook with its PR: no one answered it.
    const ended = processing ? null : endedChoice(item);
    head = processing ? "Being handled" : ended === "withdrawn" ? "Withdrawn" : ended ? "Closed" : item.status === "archived" ? "Archived" : "Decided";
    h = '<section class="panel verdict ' + (processing ? "processing" : item.status === "archived" ? "archived" : "decided") + '"><p class="slabel vhead">' + head + "</p>";
    if (d && ended === "withdrawn") {
      h += '<div class="vline"><span class="vbig withdrawn">Withdrawn</span>' + (d.decided_at ? '<span class="rel" title="' + esc(absTime(d.decided_at)) + '">' + esc(absTime(d.decided_at)) + "</span>" : "") + "</div>";
      h += '<div class="vnote">' + esc(d.note || "The question no longer applies.") + "</div>";
    } else if (d && d.choice) {
      h += '<div class="vline"><span class="vbig ' + esc(ended || d.choice) + '">' + esc(decisionLabel(item)) + "</span>" + (d.decided_at ? '<span class="rel" title="' + esc(absTime(d.decided_at)) + '">' + esc(absTime(d.decided_at)) + "</span>" : "") + "</div>";
      if (d.note) h += '<div class="vnote">' + esc(d.note) + "</div>";
    } else h += '<div class="vnote">Archived without a decision.</div>';
  }
  if (processing) h += '<div class="vwas">The orchestrator has picked this up and is acting on it.</div>';
  else if (item.status === "decided") h += '<div class="vwas">The orchestrator acts on it on its next pickup (' + esc(pickupPhrase(state.schedule)) + ").</div>";
  const next = inboxNeighbors(item.id).next;
  h += '<div class="actions after"><a class="btn" href="#inbox">Back to the inbox</a>' + (next ? '<a class="btn primary" href="' + itemHref(next) + '">Next item &rsaquo;</a>' : "") + "</div>";
  return h + "</section>";
}
function timelineBlock(item: ItemRow): string {
  const rows: [string, string][] = [];
  if (item.created_at) rows.push(["Created", absTime(item.created_at) + (item.source ? " · from " + item.source : "")]);
  const d = item.decision;
  const ended = endedChoice(item);
  if (d && d.decided_at) rows.push([ended === "withdrawn" ? "Withdrawn" : ended ? "Closed" : "Decided", absTime(d.decided_at) + " · " + decisionLabel(item)]);
  if (item.updated_at && item.updated_at !== item.created_at && !(d && d.decided_at === item.updated_at)) rows.push(["Updated", absTime(item.updated_at)]);
  if (item.status === "archived") rows.push(["Archived", item.updated_at ? absTime(item.updated_at) : "yes"]);
  if (!rows.length) return "";
  return '<section class="bk sec" id="timeline"><h3 class="slabel">History</h3><ul class="timeline">' + rows.map((r) =>
    '<li><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + "</span></li>").join("") + "</ul></section>";
}

/* ---------- prev / next, and the phone's thumb bar ---------- */
// Lives in the detail header, outside the page body, so it updates on every render. On phones it's the bottom bar:
// prev · Submit · next with "Then next: …" under it (style.css). Submit calls the same decide() as the form's
// button and shows the same state; viewers see "View only"; FYI and closed items show their place in the queue.
let pagerWired = false;
function renderPager(id: string): void {
  const pager = $("pager");
  if (!state.loaded) { pager.hidden = true; return; }
  if (!pagerWired) {
    pagerWired = true;
    pager.addEventListener("click", (ev) => {
      if (!(ev.target as Element).closest("#pager-submit") || state.route.view !== "item") return;
      if (settling(state.advancedAt, Date.now())) return; // a tap meant for the item just decided
      decide(state.route.id);
    });
  }
  const order = inboxOrder();
  if (order.includes(id)) state.navOrder = order; // a decided item keeps its place from here
  const n = inboxNeighbors(id);
  const link = (to: string | null, rel: "prev" | "next", label: string) => {
    const key = '<kbd class="kbdonly" aria-hidden="true">' + (rel === "prev" ? "k" : "j") + "</kbd>";
    // Up and down, as j / k and ↑ / ↓ move (src/lib/keys.ts).
    const text = rel === "prev" ? '<span class="parr" aria-hidden="true">&uarr;</span><span class="plbl">' + label + "</span>" + key
      : key + '<span class="plbl">' + label + '</span><span class="parr" aria-hidden="true">&darr;</span>';
    return to ? '<a class="pbtn" id="pager-' + rel + '" href="' + itemHref(to) + '" title="' + label + " (" + (rel === "prev" ? "k" : "j") + ')">' + text + "</a>"
      : '<span class="pbtn" aria-disabled="true">' + text + "</span>";
  };
  const item = itemById(id), hold = settling(state.advancedAt, Date.now());
  let mid = "", then = "";
  if (item && isOpen(item) && !isAuto(item)) {
    if (canAct(myRole())) {
      const s = submitFor(item, state.drafts.get(id) || {});
      mid = '<button type="button" class="btn primary pbsubmit" id="pager-submit" aria-describedby="submit-help' + (n.next || n.index >= 0 ? " pager-then" : "") + '"' +
          (s.enabled && !hold ? "" : " disabled") + '><span class="pslbl">' + esc(s.label) + "</span></button>";
    } else mid = '<span class="pbview">View only</span>';
  }
  if (item && isOpen(item) && canAct(myRole())) then = nextLine(id, "Then next: ");
  // From 700px this is the item pane's header: "1 of 5" and the progress segments, then prev / next with their keys.
  const pos = n.index >= 0 ? "<b>" + (n.index + 1) + "</b> of " + n.total : n.total ? n.total + " open" : "Inbox clear";
  const html = '<div class="prow">' + link(n.prev, "prev", "Previous") + '<span class="ppos mono">' + pos + "</span>" + progressBar(n.index, n.total) + mid + link(n.next, "next", "Next") +
    '<button type="button" class="iconlink kbdonly pkeys" data-key-help title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button></div>' +
    (then ? '<p class="pthen" id="pager-then">' + NEXT_ICON + "<span>" + then + "</span></p>" : "");
  // Rebuilt only when it changed, so a focused pager button keeps focus across live renders; when it
  // does change (Submit's label), focus goes back to the same control.
  if (pager.dataset.sig !== html) {
    const a = document.activeElement, fid = a && pager.contains(a) ? a.id : "";
    pager.innerHTML = html; pager.dataset.sig = html;
    if (fid) document.getElementById(fid)?.focus({ preventScroll: true });
  }
  pager.classList.toggle("deciding", !!mid);
  pager.hidden = false;
  if (hold) armSettle(id);
}

/* ---------- the phone's peek stack: what's after this item, above it, as one link back to the queue ---------- */
// Below 700px (style.css), the edges of the next items in the queue stacked like cards, nearest at the bottom, up to
// three; the link says how many asks and FYI follow this one. Only for an item in the queue: one that isn't (decided,
// opened from History) has no "next" in it. Rebuilt only when it changed.
const PEEK_CARDS = 3;
function renderPeek(item: ItemRow | null): void {
  const el = $<HTMLAnchorElement>("peek"), items = inboxItems(), order = triageOrder(items, Date.now(), state.pins);
  const i = item ? order.indexOf(item.id) : -1, rest = i >= 0 ? order.slice(i + 1) : [];
  if (!rest.length) { el.hidden = true; return; }
  const byId = new Map(items.map((x) => [x.id, x])), rows = rest.map((x) => byId.get(x)!);
  const fyi = rows.filter(isAuto).length, asks = rows.length - fyi;
  const parts = (asks ? [asks + " more " + (asks === 1 ? "ask" : "asks")] : []).concat(fyi ? [fyi + " decided for you"] : []);
  const label = "Up next: " + parts.join(" and ") + ". Open the queue.";
  const cards = rows.slice(0, PEEK_CARDS).map((r, k) => {
    const mark = isAuto(r) ? "fyi" : "pd-" + prioOf(r);
    return '<span class="pk d' + (k + 1) + '"><span class="pkrow"><span class="pm ' + mark + '"></span><span class="pkt">' + esc(headlineOf(r)) + "</span>" +
      relSpan(r.created_at, true) + "</span></span>";
  });
  // The farthest first, so each nearer card covers the one behind it.
  const html = '<span class="pks n' + cards.length + '" aria-hidden="true">' + cards.reverse().join("") + "</span>";
  if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  if (el.getAttribute("aria-label") !== label) el.setAttribute("aria-label", label);
  el.hidden = false;
}

// The desk's hint bar under the item pane (index.html #key-hints, shown from 1100px): the keys this item takes, then
// "? All keys". The hints repeat the list the button opens, so only the button is in the accessibility tree.
function renderKeyBar(kind: HintKind, snooze = false): void {
  const bar = $("key-hints"), key = kind + (snooze ? "+snooze" : "");
  if (bar.dataset.kind === key) return;
  const refocus = bar.contains(document.activeElement);
  bar.dataset.kind = key;
  bar.innerHTML = '<span class="khints" aria-hidden="true">' + keyHints(kind, snooze).map((h) =>
    '<span class="kbh">' + h.keys.map((k) => "<kbd>" + esc(k) + "</kbd>").join("") + "<span>" + esc(h.label) + "</span></span>").join("") + "</span>" +
    '<button type="button" class="kball" data-key-help aria-haspopup="dialog" aria-keyshortcuts="?"><kbd aria-hidden="true">?</kbd>All keys</button>';
  if (refocus) bar.querySelector<HTMLElement>(".kball")?.focus({ preventScroll: true });
}

/* ---------- snooze: hide an open item from the Inbox until a preset time ---------- */
// A signed-in human only (the endpoint is 403 for tokens).
function snoozeBlock(item: ItemRow): string {
  const row = snoozeRow(item);
  // In the aside, s (src/views/keys.ts) goes to the first preset: its hint is on the heading.
  const key = snoozeInline() ? '<kbd class="khint kbdonly" aria-hidden="true">s</kbd>' : "";
  return row ? '<section class="bk sec snzsec" id="snooze"><h3 class="slabel">Snooze' + key + "</h3>" + row + "</section>" : "";
}
// The snooze's own status line, beside its controls (in the More sheet below 1100px, so it's seen there).
let snoozeStatus: { id: string; msg: string; kind: string } | null = null;
// Below 1100px the presets open from "Snooze…" (or "Change…"); from 1100px they're drawn in the aside, no toggle.
const snoozeInline = (): boolean => inlineSecondary();
function snoozeRow(item: ItemRow): string {
  if (!myEmail()) return "";
  const now = Date.now(), on = isSnoozed(item, now), dis = state.busy.has(item.id) ? " disabled" : "", inline = snoozeInline(), menu = inline || state.snoozeMenu === item.id;
  let h = '<div class="snz"><div class="snzrow">';
  h += on ? '<span class="snzon">' + SNOOZE_ICON + '<span>Snoozed for you until <b>' + esc(wakeText(item.snoozed_until, now)) + "</b></span></span>"
    : '<span class="small-note">Not now? Hide it from your inbox; it comes back on its own.</span>';
  h += '<span class="snzacts">' + (on ? '<button type="button" class="btn" id="unsnooze-btn"' + dis + ">Unsnooze</button>" : "") +
    (inline ? "" : '<button type="button" class="btn" id="snooze-btn" aria-expanded="' + menu + '" aria-controls="snooze-menu"' + dis + ">" + SNOOZE_ICON +
    (on ? "Change…" : "Snooze…") + '<kbd class="khint kbdonly" aria-hidden="true">s</kbd></button>') + "</span></div>";
  if (menu) {
    h += '<div class="snzmenu" id="snooze-menu" role="group" aria-label="Snooze until">' + snoozePresets(now, scheduleZone()).map((p) =>
      '<button type="button" class="btn snzopt" id="snooze-' + p.id + '" data-snooze="' + p.id + '"' + dis + '><span class="snzlbl">' + esc(p.label) + "</span>" +
      '<span class="snzat">' + esc(wakeText(p.until, now)) + "</span></button>").join("") + "</div>";
  }
  const st = snoozeStatus && snoozeStatus.id === item.id ? snoozeStatus : null;
  h += '<div class="status' + (st && st.kind ? " " + st.kind : "") + '" id="snooze-status" role="status">' + esc(st ? st.msg : "") + "</div>";
  return h + "</div>";
}
// What the menu shows, for the render signature: "1 hour" moves every minute, the others at 6 pm and midnight. The
// aside's presets are always drawn, so there only the presets themselves count (they change at 6 pm and midnight) and
// their wake times are kept fresh in place (refreshSnoozeTimes): the page isn't rebuilt under the viewer every minute.
function snoozeSig(item: ItemRow): unknown {
  const st = snoozeStatus && snoozeStatus.id === item.id ? snoozeStatus.msg : "";
  const now = Date.now();
  if (snoozeInline()) return [st, isSnoozed(item, now), snoozePresets(now, scheduleZone()).map((p) => p.id + p.label)];
  if (state.snoozeMenu !== item.id) return [isSnoozed(item), st];
  return [st, isSnoozed(item, now), snoozePresets(now, scheduleZone()).map((p) => p.label + wakeText(p.until, now))];
}
function refreshSnoozeTimes(): void {
  if (!snoozeInline()) return;
  const now = Date.now(), presets = snoozePresets(now, scheduleZone());
  document.querySelectorAll<HTMLElement>("#snooze-menu [data-snooze]").forEach((b) => {
    const p = presets.find((x) => x.id === b.dataset.snooze), at = b.querySelector(".snzat");
    if (p && at && at.textContent !== wakeText(p.until, now)) at.textContent = wakeText(p.until, now);
  });
}
function wireSnooze(item: ItemRow): void {
  const id = item.id;
  document.getElementById("snooze-btn")?.addEventListener("click", () => {
    state.snoozeMenu = state.snoozeMenu === id ? null : id; rerender();
    if (state.snoozeMenu) (document.querySelector("#snooze-menu .snzopt") as HTMLElement | null)?.focus();
  });
  document.getElementById("unsnooze-btn")?.addEventListener("click", () => { snoozeItem(id, null); });
  document.querySelectorAll<HTMLElement>("#snooze-menu [data-snooze]").forEach((b) => {
    b.addEventListener("click", () => {
      // Computed at the tap, so "1 hour" is an hour from now, not from when the menu opened.
      const p = snoozePresets(Date.now(), scheduleZone()).find((x) => x.id === b.dataset.snooze);
      if (p) snoozeItem(id, p.until);
    });
  });
}
// Esc on an item page closes an open Snooze menu before it goes back to the list.
export function closeSnoozeMenu(): boolean {
  if (!state.snoozeMenu) return false;
  state.snoozeMenu = null; rerender();
  document.getElementById("snooze-btn")?.focus();
  return true;
}
// The viewer's own snooze: the item doesn't change, so nothing to pin. Snoozing the item on screen moves on to the
// next one, like deciding does.
async function snoozeItem(id: string, until: string | null): Promise<void> {
  if (!itemById(id) || state.busy.has(id)) return;
  const order = queueOrder(id);
  state.busy.add(id); state.snoozeMenu = null; snoozeStatus = { id, msg: "Saving…", kind: "" }; rerender();
  try {
    const r = await store.snooze(id, until);
    applySnooze(r.item_id, r.until);
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "unknown", String(e));
    if (err.status === 409 && err.current) applyItem(err.current as unknown as Doc<Item>);
    state.busy.delete(id);
    const msg = err.status === 409 ? "Already decided elsewhere: nothing to snooze."
      : err.status === 404 ? "This item isn't in the inbox any more."
      : err.status === 403 ? "Only deciders can snooze items."
      : err.status === 400 ? "Couldn't snooze it: " + err.message
      : err.status === 401 ? "Signed out — reload to sign in again."
      : "Couldn't save the snooze. Try again.";
    snoozeStatus = { id, msg, kind: "err" };
    rerender(); rowsChanged();
    // Beside the snooze controls; when they're gone (decided elsewhere), on the page's status line and as a toast.
    if (document.getElementById("snooze-status")) announce(msg); else { snoozeStatus = null; setStatus(id, msg, "err"); toast(msg); }
    return;
  }
  state.busy.delete(id); snoozeStatus = null; rowsChanged();
  if (until === null) { toast("Unsnoozed: back in the inbox"); rerender(); return; }
  toast("Snoozed until " + wakeText(until));
  if (state.route.view === "item" && state.route.id === id) {
    const next = advanceTarget(order, id, inboxItems(), Date.now(), state.pins);
    state.advancedAt = Date.now();
    replaceWith(next ? itemHref(next) : "#inbox");
    return;
  }
  rerender();
}

/* ---------- assignee: routing, not a lock (anyone can still decide) ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
function assigneeName(email: string): string { return email === myEmail() ? "You" : personName(email, state.people); }
function assignDraft(id: string): AssignDraft {
  let a = state.assigns.get(id);
  if (!a) { a = { open: false, email: "", busy: false, msg: "", kind: "" }; state.assigns.set(id, a); }
  return a;
}
// Who it's routed to, and for a signed-in human on an open item: assign to me, unassign, or someone else by email.
// Hidden in a one-person inbox (nobody assigned, nobody in People), like the Inbox filter, and for viewers.
function assigneeBlock(item: ItemRow): string {
  const me = myEmail(), cur = item.assignee || "", a = state.assigns.get(item.id) || ({} as Partial<AssignDraft>);
  const controls = !!me && canAct(myRole()) && isOpen(item) && assigneesInUse(state.items, state.people);
  if (!cur && !controls) return "";
  const dis = a.busy ? " disabled" : "", note = pushNote(cur || undefined, state.people);
  let h = '<section class="assignee sec" id="assignee"><h3 class="slabel">Assignee</h3><div class="arow">';
  h += (cur ? '<span class="aname">' + assigneeBadge(cur) + "<b>" + esc(assigneeName(cur)) + '</b><span class="aemail">' + esc(cur) + "</span>"
    : '<span class="aname none">Unassigned') + (note ? ' <span class="small-note">· ' + esc(note) + "</span>" : "") + "</span>";
  if (controls) {
    h += '<span class="aacts">' +
      (cur !== me ? '<button type="button" class="btn" id="assign-me"' + dis + ">Assign to me</button>" : "") +
      (cur ? '<button type="button" class="btn" id="unassign"' + dis + ">Unassign</button>" : "") +
      '<button type="button" class="btn" id="assign-other" aria-expanded="' + !!a.open + '" aria-controls="assign-form"' + dis + ">Someone else…</button></span>";
  }
  h += "</div>";
  if (controls && a.open) {
    const others = state.people.filter((p) => p.email !== me && p.email !== cur);
    h += '<form class="aform" id="assign-form" autocomplete="off" novalidate><label class="flabel" for="assign-field">Assign to</label><div class="frow">' +
      '<input class="inp" type="email" id="assign-field" list="people-list" maxlength="254" spellcheck="false" autocapitalize="off" placeholder="teammate@example.com" value="' + esc(a.email || "") + '"' + dis + ">" +
      '<datalist id="people-list">' + others.map((p) => '<option value="' + esc(p.email) + '">' + esc(p.name || "") + "</option>").join("") + "</datalist>" +
      '<button type="submit" class="btn primary" id="assign-send"' + (a.busy || !EMAIL_RE.test((a.email || "").trim()) ? " disabled" : "") + ">" + (a.busy ? "Saving…" : "Assign") + "</button></div></form>";
  }
  if (a.msg) h += '<div class="status' + (a.kind ? " " + a.kind : "") + '" id="assign-status">' + esc(a.msg) + "</div>";
  return h + "</section>";
}
function wireAssign(item: ItemRow): void {
  const id = item.id, me = myEmail();
  document.getElementById("assign-me")?.addEventListener("click", () => { if (me) assignTo(id, me); });
  document.getElementById("unassign")?.addEventListener("click", () => { assignTo(id, null); });
  document.getElementById("assign-other")?.addEventListener("click", () => {
    const a = assignDraft(id); a.open = !a.open; a.msg = ""; rerender();
    if (a.open) document.getElementById("assign-field")?.focus();
  });
  const field = document.getElementById("assign-field") as HTMLInputElement | null; if (!field) return;
  field.addEventListener("input", () => {
    assignDraft(id).email = field.value;
    const s = document.getElementById("assign-send") as HTMLButtonElement | null; if (s) s.disabled = !EMAIL_RE.test(field.value.trim());
  });
  $("assign-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const email = field.value.trim().toLowerCase();
    if (EMAIL_RE.test(email)) assignTo(id, email);
  });
}
// A PATCH pinned on the version this page shows: a reassign elsewhere (or any other write) meanwhile is a 409.
async function assignTo(id: string, email: string | null): Promise<void> {
  const a = assignDraft(id);
  if (a.busy) return;
  a.busy = true; a.msg = ""; a.kind = ""; rerender();
  try {
    applyItem(await store.patchItem(id, { assignee: email }, state.versions.get(id)));
    a.busy = false; a.open = false; a.email = ""; rerender(); rowsChanged();
    toast(email ? "Assigned to " + (email === myEmail() ? "you" : personName(email, state.people)) : "Unassigned");
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "unknown", String(e));
    a.busy = false; a.kind = "err";
    if (err.status === 409 && err.current) {
      applyItem(err.current as unknown as Doc<Item>);
      a.msg = "This item changed while you were looking. Check the assignee above and try again.";
    } else {
      a.msg = err.status === 400 ? "Couldn't assign it: " + err.message
        : err.status === 403 ? "You don't have permission to reassign items on this inbox."
        : err.status === 404 ? "This item was removed by the orchestrator."
        : err.status === 401 ? "Signed out — reload to sign in again."
        : "Couldn't save the assignee. Try again.";
    }
    rerender(); rowsChanged(); announce(a.msg);
  }
}

/* ---------- ask a question ---------- */
function askDraft(id: string): AskDraft {
  let a = state.asks.get(id);
  if (!a) { a = { open: false, text: "", busy: false, msg: "", kind: "" }; state.asks.set(id, a); }
  return a;
}
// user on the right; manager and orchestrator answers on the left (orchestrators labelled with the item's id, e.g. "O3").
function msgWho(m: QaMsg, item: Item): string {
  return m.role === "user" ? "You" : m.role === "orchestrator" ? (item.orchestrator || "Manager") : m.role === "manager" ? "Orchestrator" : String(m.role || "Orchestrator");
}
export function msgHtml(m: QaMsg, item: Item): string {
  const user = m.role === "user", who = msgWho(m, item);
  return '<li class="msg ' + (user ? "user" : "manager") + '"><span class="who">' + (user ? "" : "<b>" + esc(who) + "</b>") + relSpan(m.created_at, false) + "</span>" +
    (user ? '<div class="bubble">' + esc(m.text) + "</div>" : '<div class="bubble md">' + md(m.text) + "</div>") + "</li>";
}
function qaBlock(item: ItemRow, qa: typeof state.qa | null): string {
  const a = state.asks.get(item.id) || ({} as Partial<AskDraft>);
  const msgs = qa && qa.loaded ? qa.msgs.filter((m) => m && typeof m.text === "string") : [];
  let h = '<section class="qa sec" id="qa"><h3 class="slabel">Questions' + (msgs.length ? " &middot; " + msgs.length : "") + "</h3>";
  if (msgs.length) h += '<ol class="thread">' + msgs.map((m) => msgHtml(m, item)).join("") + "</ol>";
  else if (qa && qa.failed) h += '<div class="status err">Couldn\'t load the questions for this item. Reload to try again.</div>';
  if (item.qa_pending) h += '<div class="qwait">Waiting for the orchestrator (' + esc(pickupPhrase(state.schedule)) + ")</div>";
  if (!canAct(myRole())) {
    if (!msgs.length) h += '<p class="small-note">No questions yet. Asking is for deciders and admins.</p>';
  } else if (!a.open) {
    if (!msgs.length && !item.qa_pending) h += '<p class="small-note">Not sure yet? Ask the orchestrator. It answers here, and the item stays open.</p>';
    // In the aside a (src/views/keys.ts) opens it; the sheet takes no keys while it's open, so no hint there.
    h += '<div><button type="button" class="btn" id="ask-open">' + ASK_ICON + "Ask a question" + (inlineSecondary() ? '<kbd class="khint kbdonly" aria-hidden="true">a</kbd>' : "") + "</button></div>";
  } else {
    h += '<div class="panel askbox" id="ask-box">' +
      '<label class="notelbl" for="ask-field"><span>Your question</span><span class="req">answered here, item stays open</span></label>' +
      '<textarea class="note" id="ask-field" maxlength="2000" placeholder="What do you need to know before deciding?"' + (a.busy ? " disabled" : "") + ">" + esc(a.text || "") + "</textarea>" +
      '<div class="actions split"><button type="button" class="btn" id="ask-cancel"' + (a.busy ? " disabled" : "") + ">Cancel</button>" +
      '<button type="button" class="btn primary" id="ask-send"' + (a.busy || !(a.text || "").trim() ? " disabled" : "") + ">" + (a.busy ? "Sending…" : "Send question") + "</button></div></div>";
  }
  if (a.msg) h += '<div class="status' + (a.kind ? " " + a.kind : "") + '" id="ask-status">' + esc(a.msg) + "</div>";
  return h + "</section>";
}
function wireAsk(item: ItemRow): void {
  const id = item.id, openBtn = document.getElementById("ask-open");
  if (openBtn) openBtn.addEventListener("click", () => {
    const a = askDraft(id); a.open = true; a.msg = ""; rerender();
    document.getElementById("ask-field")?.focus();
  });
  const field = document.getElementById("ask-field") as HTMLTextAreaElement | null; if (!field) return;
  field.addEventListener("input", () => {
    askDraft(id).text = field.value;
    const s = document.getElementById("ask-send") as HTMLButtonElement | null; if (s) s.disabled = !field.value.trim();
  });
  $("ask-cancel").addEventListener("click", () => { askDraft(id).open = false; rerender(); });
  $("ask-send").addEventListener("click", () => { askSubmit(id); });
}
async function askSubmit(id: string): Promise<void> {
  const a = askDraft(id), text = (a.text ?? "").trim();
  if (!text || a.busy) return;
  a.busy = true; a.msg = ""; a.kind = ""; rerender();
  try {
    // Asked from the snapshot saved on this device, before the server confirmed it: bound to what was shown.
    const r = await store.ask(id, text, state.revalidated ? undefined : state.versions.get(id));
    applyItem(r.item);
    if (state.qa.id === id && !state.qa.msgs.some((m) => m.id === r.message.id)) state.qa.msgs = state.qa.msgs.concat([{ ...r.message.data, id: r.message.id }]);
    a.busy = false; a.msg = ""; a.open = false; a.text = "";
    rerender(); rowsChanged();
    toast("Question sent. The orchestrator answers on its next pickup (" + pickupPhrase(state.schedule) + ").");
  } catch (e) {
    const st = e instanceof ApiError ? e.status : 0;
    a.busy = false; a.kind = "err";
    if (st === 409 && e instanceof ApiError && e.current) applyItem(e.current as unknown as Doc<Item>);
    a.msg = st === 401 ? "Signed out — reload to sign in again."
      : st === 409 ? "This item changed since this copy was saved. Check it, then send your question again."
      : st === 403 ? "You don't have permission to ask questions on this inbox."
      : st === 404 ? "This item was removed by the orchestrator."
      : st === 400 && e instanceof ApiError ? "Couldn't send the question: " + e.message
      : "Couldn't send the question. Try again.";
    rerender(); rowsChanged(); announce(a.msg);
  }
}

/* ---------- deciding ---------- */
function setStatus(id: string, msg: string, kind?: string): void {
  if (msg) state.itemStatus.set(id, { msg, kind: kind || "" }); else state.itemStatus.delete(id);
  const s = document.getElementById("decide-status");
  // Not an alert any more (a 409's): this message is announced once, through #sr-status.
  if (s && state.route.view === "item" && state.route.id === id) { s.removeAttribute("role"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); announce(msg); }
}

// Shared write path for every page-side decision. The server checks "still open" atomically (409 not_open), and the
// decision is pinned to the version this page shows, so an item that changed meanwhile is a 409 conflict, not decided.
// `redraw`: decided from a list row (Looks good on an FYI row, src/views/index.ts), which it re-renders as the busy
// state changes; that list has no status line, so an error toasts there.
export async function commitItem(id: string, choice: string, note: string, toastMsg: string, redraw?: () => void): Promise<void> {
  const item = itemById(id);
  if (!item || state.busy.has(id)) return;
  const order = queueOrder(id); // "next" is the queue as it stood when the decision was sent
  const draw = () => { rerender(); if (redraw) redraw(); else rowsChanged(); };
  state.busy.add(id); setStatus(id, "Saving…"); draw();
  const finish = (msg: string, kind: string, toasted = false) => {
    // From a list, off the item's page: the error toasts, and isn't kept to greet the item's page later.
    const offPage = !!redraw && !(state.route.view === "item" && state.route.id === id);
    state.busy.delete(id); setStatus(id, offPage ? "" : msg, kind); draw();
    if (offPage && kind === "err" && !toasted) toast(msg);
  };
  try {
    applyItem(await store.decide(id, choice, note, state.versions.get(id)));
    // The row leaves the lists at once: the one it was pressed in, and the one beside the item (the split view).
    redraw?.(); rowsChanged();
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, "unknown", String(e));
    if (err.status === 409 && err.current) {
      const c = decideConflict(item, err.current.data as unknown as Item);
      applyItem(err.current as unknown as Doc<Item>);
      // Changed under the human: the option they picked may now say something else, so they pick again (the note stays).
      // null, not deleted: the recommendation isn't pre-selected again either.
      if (c.changed) draftFor(id).choice = null;
      if (redraw && !(state.route.view === "item" && state.route.id === id)) { finish(c.msg, "err", true); toast(c.msg); return; }
      // On the item's page the status line says it as an alert (statusLine), announced once: not again through
      // #sr-status, and the toast shows it without announcing it a third time. A page that didn't rebuild gets the
      // alert on its line here; with no line (the item closed elsewhere: its verdict shows) the toast announces it.
      state.busy.delete(id); state.itemStatus.set(id, { msg: c.msg, kind: "err", alert: true }); draw();
      const line = state.route.view === "item" && state.route.id === id ? document.getElementById("decide-status") : null;
      if (line && line.getAttribute("role") !== "alert") {
        const st = state.itemStatus.get(id); if (st) st.alert = false;
        line.className = "status err"; line.setAttribute("role", "alert"); setLive(line, c.msg);
      }
      // Off the item (left before the answer came): the toast announces it, so reopening the item doesn't again.
      if (!line) { const st = state.itemStatus.get(id); if (st) st.alert = false; }
      toast(c.msg, false, !!line);
      return;
    }
    return finish(err.status === 404 ? "This item was removed by the orchestrator."
      : err.status === 403 ? "You don't have permission to decide items on this inbox."
      : err.status === 401 ? "Signed out — reload to sign in again."
      : err.status === 400 ? "Couldn't save the decision: " + err.message
      : "Couldn't save the decision. Try again.", "err");
  }
  toast(toastMsg);
  // Auto-advance while the viewer is still on this item: the next one in the inbox's order, or the inbox after the last.
  // replace, not push, so Back from the next item doesn't land on the page just decided.
  if (state.route.view === "item" && state.route.id === id) {
    state.busy.delete(id); setStatus(id, "");
    const next = advanceTarget(order, id, inboxItems(), Date.now(), state.pins);
    state.advancedAt = Date.now();
    replaceWith(next ? itemHref(next) : "#inbox");
    return;
  }
  finish(redraw ? "" : "Saved.", "ok");
}

function decide(id: string): void {
  const d = state.drafts.get(id) || {}, item = itemById(id);
  const choice = item ? effChoice(item, d) : undefined;
  if (!item || !choice || !canSubmit(item, d)) return;
  const note = (d.note || "").trim();
  if (choice === "other" && !note) { setStatus(id, "Write a note to explain Other.", "err"); return; }
  commitItem(id, choice, note, "Decided: " + labelFor(item, choice) + " · " + pickupPhrase(state.schedule));
}

// auto_decided: "Looks good" archives it; nothing for the manager to act on.
function acceptAuto(id: string): void {
  commitItem(id, "accept", "", "Archived: looks good");
}
// auto_decided: "Override…" needs a note; the server keeps the agent's call in override_of.
function overrideAuto(id: string): void {
  const d = state.drafts.get(id) || {}, item = itemById(id), note = (d.note || "").trim();
  if (!item) return;
  if (!note) { setStatus(id, "Write a note to explain the override.", "err"); return; }
  commitItem(id, "override", note, "Overridden · " + pickupPhrase(state.schedule));
}

/* ---------- Q&A thread of the item being shown ---------- */
// Loaded on route change into an item and when the change feed reports items/<id>/qa; never from render.
export async function loadQa(id: string): Promise<void> {
  if (state.qa.id !== id) state.qa = { id, msgs: [], loaded: false, failed: false };
  try {
    const docs = await store.listQa(id);
    if (state.qa.id !== id) return;
    state.qa.msgs = docs.map((d) => ({ ...d.data, id: d.id }));
    state.qa.loaded = true; state.qa.failed = false;
  } catch {
    if (state.qa.id !== id) return;
    if (!state.qa.loaded) { state.qa.failed = true; state.qa.loaded = true; }
  }
  rerender();
}
