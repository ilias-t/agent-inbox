import { esc, safeUrl } from "../lib/dom.ts";
import {
  PRIO_LABEL, ROW_TYPE, headlineOf, initials, isOpen, itemHref, orchStatusLabel, personName, prChip, prioOf, rowMeta, typeOf, verdictOf,
  type ItemRow, type MetaPart, type OrchRow,
} from "../lib/items.ts";
import { canAct } from "../lib/roles.ts";
import { absTime, relSpan, slotTime, zoneClock, zoneStamp } from "../lib/time.ts";
import { myEmail, myRole, scheduleZone, state } from "../state.ts";

export const CHAT_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 4.5h13v9h-7l-4 3v-3h-2z"/></svg>';
export const ASK_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M8 8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.7"/><path d="M10 13.8v.2"/></svg>';

// The assignee as initials in a small circle (accent when it's the viewer); the name is in the title.
export function assigneeBadge(email: string): string {
  const mine = email === myEmail(), name = personName(email, state.people);
  return '<span class="who' + (mine ? " me" : "") + '" role="img" title="Assigned to ' + esc(mine ? "you" : name) + " (" + esc(email) + ')" aria-label="Assigned to ' +
    esc(mine ? "you" : name) + '">' + esc(initials(name)) + "</span>";
}

export const SNOOZE_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="11" r="6.5"/><path d="M10 7.5V11l2.2 1.6"/><path d="M3.5 4.2 5.8 2.5M16.5 4.2l-2.3-1.7"/></svg>';

// When a snoozed item wakes, in the schedule's zone: "today 18:00 ET", "Thu 09:00 ET".
export function wakeText(until: unknown, now = Date.now()): string { return slotTime(until, scheduleZone(), now, true, "today"); }

// server: an older archived item History's server search found (not loaded on the page). clock: the time of day in
// this zone (History passes the schedule's, looked up once per render) in place of the relative time, for rows under
// a day header.
export interface RowOpts { past?: boolean; fyi?: boolean; hideOrch?: boolean; snoozed?: boolean; server?: boolean; clock?: string; side?: string }

const svg = (body: string, w = "2.2") => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
// The row's leading mark. Open asks: priority (high a filled dot, normal a ring, low a dash). FYI: a small square.
// Snoozed: a clock. Past: what happened (decided, accepted, overridden, being handled, archived, withdrawn, closed).
function rowMark(item: ItemRow, opts: RowOpts, type: string): string {
  if (opts.snoozed) return '<span class="pm clock" title="' + esc(type) + ', snoozed">' + svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', "2") + "</span>";
  if (opts.fyi) return '<span class="pm fyi" title="' + esc(type) + '"></span>';
  if (opts.past) {
    const v = verdictOf(item).verdict;
    const icon = v === "Being handled" ? '<circle class="trk" cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8"/>'
      : v === "Overridden" ? '<path d="M5 18v-3a5 5 0 0 1 5-5h9"/><path d="M15 6l4 4-4 4"/>'
      : v === "Accepted" ? '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M8.5 12.2l2.5 2.5 4.6-5"/>'
      : v === "Archived" || v === "Closed" || v === "Withdrawn" ? '<path d="M7 12h10"/>' : CHECK;
    return '<span class="pm past' + (v === "Being handled" ? " handling" : "") + '" title="' + esc(type + ": " + v) + '">' + svg(icon) + "</span>";
  }
  const p = prioOf(item);
  return '<span class="pm pd-' + p + '" title="' + esc(PRIO_LABEL[p]) + ' priority"></span>';
}

// One part of the meta line (src/lib/items.ts rowMeta). Spaces between parts keep the link's accessible name readable.
function metaPart(item: ItemRow, m: MetaPart): string {
  switch (m.k) {
    case "type": return '<span class="mt">' + esc(m.text) + "</span>";
    case "chose": return '<span class="mt">' + esc(m.who) + " chose</span> " + '<span class="mc">' + esc(m.text) + "</span>";
    case "verdict": return '<span class="mt' + (m.handling ? " acc" : "") + '">' + esc(m.text) + "</span>";
    case "choice": return '<span class="mc' + (m.choice === "reject" ? " reject" : "") + '">' + esc(m.text) + "</span>";
    case "orch": return '<span class="mo">' + esc(m.text) + "</span>";
    case "who": return m.me
      ? '<span class="mw me" title="Assigned to you (' + esc(m.email) + ')"><span class="vh">Assigned to </span>You</span>'
      : '<span class="mw" title="Assigned to ' + esc(m.name) + " (" + esc(m.email) + ')"><span class="vh">Assigned to </span><span class="who" aria-hidden="true">' +
        esc(m.initials) + "</span>" + esc(m.name) + "</span>";
    case "answered": return '<span class="ma" title="The orchestrator answered your question">Answered</span>';
    case "asked": return '<span class="asked" title="Waiting for the orchestrator to answer">? asked</span>';
    case "conf": return '<span class="mconf ' + m.conf + '">' + esc(m.text) + "</span>";
    case "pr": return prChip(item, true);
    case "wake": return '<span class="wake" title="' + esc(absTime(m.until)) + '">until ' + esc(wakeText(m.until)) + "</span>";
  }
}
// One index row: a grid of the mark, the headline (two lines at most) over one meta line, the time and a chevron.
// FYI rows put the agent's call and Looks good / Override… on a line of their own under the link (buttons can't sit
// inside it); past rows say what happened; snoozed rows when they come back, with Unsnooze beside them (`side`).
export function itemRow(item: ItemRow, opts: RowOpts = {}): string {
  const cls = "rowwrap" + (opts.fyi ? " fyi" : "") + (opts.snoozed ? " snoozed" : "") + (opts.past ? " past" : "") + (opts.server ? " srv" : "");
  const parts = rowMeta(item, { ...opts, me: myEmail(), people: state.people, seen: state.seen });
  const meta = parts.length ? '<span class="rmeta"' + (opts.fyi ? ' aria-hidden="true"' : "") + ">" + parts.map((m) => metaPart(item, m)).join(" ") + "</span>" : "";
  // The type for screen readers where the meta line doesn't say it (a tooltip on the mark for everyone else). An FYI's
  // line sits outside its link, beside the buttons: a hidden copy inside the link puts the agent's call in its name.
  const typeHint = opts.fyi || opts.past || opts.snoozed ? '<span class="vh">, ' + esc(ROW_TYPE[typeOf(item)]) +
    (opts.fyi && parts.length ? ". " + parts.map((m) => metaPart(item, m)).join(" ") : "") + "</span>" : "";
  let h = '<div class="' + cls + '"' + (opts.server ? " data-server" : "") + '><a class="row irow" href="' + itemHref(item.id) + '">' + rowMark(item, opts, ROW_TYPE[typeOf(item)]) +
    '<span class="rbody"><span class="rtitle">' + esc(headlineOf(item)) + "</span>" + typeHint + (opts.fyi ? "" : " " + meta) + "</span>";
  const at = opts.past ? (item.decision?.decided_at || item.updated_at) : item.created_at;
  // A clock time isn't a .rel[data-ts]: the minute timer leaves it alone.
  // Its tooltip: the full time in the same zone, named.
  if (opts.clock) { const c = zoneClock(at, opts.clock); if (c) h += ' <span class="rel clk" title="' + esc(zoneStamp(at, opts.clock)) + '">' + esc(c) + "</span>"; }
  else if (!opts.snoozed) h += " " + relSpan(at, true);
  h += '<span class="chev" aria-hidden="true">&rsaquo;</span></a>';
  if (opts.fyi) h += '<div class="fyiline">' + meta + fyiActions(item) + "</div>";
  return h + (opts.side || "") + "</div>";
}

// Looks good / Override… on an open FYI row (src/views/index.ts wires them); none for viewers, as on the item page.
function fyiActions(item: ItemRow): string {
  if (!isOpen(item) || !canAct(myRole())) return "";
  // Busy is aria-disabled, not disabled, so a button pressed from the keyboard keeps focus while it saves.
  const dis = state.busy.has(item.id) ? ' aria-disabled="true"' : "", name = esc(headlineOf(item));
  return '<span class="fyiacts"><button type="button" class="btn fyiok" data-ack="' + esc(item.id) + '"' + dis + ' aria-label="Looks good: ' + name + '">' +
    svg(CHECK) + "Looks good</button>" +
    '<button type="button" class="btn fyiovr" data-ovr="' + esc(item.id) + '"' + dis + ' aria-label="Override: ' + name + '">Override…</button></span>';
}

export function chatButton(orch: OrchRow | null, label: string): string {
  const u = orch && safeUrl(orch.session_url);
  if (!u) return "";
  // `orch relink` found no running session for this manager: the link is its last known one.
  const stale = orch && orch.session_live === false;
  return '<a class="btn' + (stale ? " stale" : "") + '" href="' + esc(u) + '" target="_blank" rel="noopener"' + (stale ? ' title="This session isn\'t running. The link may not open it."' : "") + ">" +
    CHAT_ICON + esc(label) + (stale ? " (link may be stale)" : "") + "</a>";
}

export function linksBlock(links: { label?: string; url?: string }[]): string {
  const parts = (Array.isArray(links) ? links : []).map((l) => {
    const u = l && safeUrl(l.url); if (!u) return "";
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(l.label || u) + "</a>";
  }).filter(Boolean);
  return parts.length ? '<div class="links">' + parts.join("") + "</div>" : "";
}

export function section(label: string, body: string, cls?: string): string {
  return '<section class="bk' + (cls ? " " + cls : "") + '"><p class="slabel">' + esc(label) + "</p>" + body + "</section>";
}

// A loading placeholder of `bars` grey lines (their widths come from the stylesheet).
export function skeleton(bars: number): string {
  return '<div class="panel skel" aria-busy="true">' + '<div class="bar"></div>'.repeat(bars) + "</div>";
}

// An orchestrator's status: a dot in its colour and the word (Team rows, the orchestrator page).
export function orchBadge(o: OrchRow): string {
  return '<span class="badge ost ' + esc(o.status || "proposed") + '">' + esc(orchStatusLabel(o.status)) + "</span>";
}
