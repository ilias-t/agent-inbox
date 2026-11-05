import type { Confidence, Doc, Item, Option, Orchestrator, Person, Priority, Snoozes } from "../../shared/types.ts";
import { baseChoices, GITHUB_CHOICE, isReviewAsk } from "../../shared/choices.ts";
import { esc } from "./dom.ts";
import { toMs } from "./time.ts";

// Docs come over the wire as {id, version, data}; the views render the artifact's flat shapes.
// snoozed_until is view-only: the signed-in human's own snooze (/api/state's `snoozes`), never the doc's.
export type ItemRow = Item & { id: string; snoozed_until?: string };
export type OrchRow = Orchestrator & { id: string };

// `snoozes`: the viewer's own (item id → until). Items snoozed before snoozes were per person may still carry
// snoozed_until / snoozed_by in their data: someone else's, so they're dropped.
export function flattenItem(d: Doc<Item>, snoozes: Snoozes = {}): ItemRow {
  const { snoozed_until: _until, snoozed_by: _by, ...data } = d.data;
  const row: ItemRow = { ...(data as Item), id: d.id };
  if (Object.hasOwn(snoozes, d.id)) row.snoozed_until = snoozes[d.id];
  return row;
}
// Orchestrators read id-first, as in the artifact (data.id, forced to the doc id by the server, wins).
export function flattenOrch(d: Doc<Orchestrator>): OrchRow {
  return { id: d.id, ...d.data } as OrchRow;
}

export const PRIO: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
export const PRIO_LABEL: Record<Priority, string> = { high: "High", normal: "Normal", low: "Low" };
export const TYPE_LABEL: Record<string, string> = { proposal: "Proposal", decision: "Decision", pr_ready: "PR ready", blocker: "Blocker", info: "Info", auto_decided: "Auto-decided" };
export const ORCH_ORDER: Record<string, number> = { blocked: 0, running: 1, "pr-open": 2, parked: 3, approved: 4, proposed: 5, done: 6, cleaned: 7, dropped: 8 };
// An orchestrator's status as the Team list and its page say it: "PR open", "Blocked"; an unknown one as written.
const ORCH_STATUS_LABEL: Record<string, string> = {
  blocked: "Blocked", running: "Running", "pr-open": "PR open", parked: "Parked", approved: "Approved", proposed: "Proposed", done: "Done", cleaned: "Cleaned", dropped: "Dropped",
};
export function orchStatusLabel(status: string | undefined): string {
  const s = status || "proposed";
  return ORCH_STATUS_LABEL[s] ?? s;
}
export const CONF_LABEL: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
export const CONF_SHORT: Record<Confidence, string> = { high: "high conf", medium: "med conf", low: "low conf" };
// pr_state from the GitHub webhook: long label for the item page, short one for the dense rows.
export const PR_LABEL: Record<string, string> = { open: "PR open", merged: "PR merged", closed: "PR closed", approved: "PR approved", changes_requested: "changes requested", commented: "PR commented" };
export const PR_SHORT: Record<string, string> = { open: "PR open", merged: "merged", closed: "PR closed", approved: "approved", changes_requested: "changes", commented: "comment" };

export type OptionView = Option & { other?: boolean };
export const OTHER: OptionView = { id: "other", label: "Other…", description: "Write your own answer in the note below.", other: true };
// A review routine's ask (shared/choices.ts): Done on GitHub, before Other.
export const GITHUB: OptionView = { ...GITHUB_CHOICE, description: "You handled it on GitHub yourself: the routine posts nothing." };

export function prioOf(item: Item): Priority { return item.priority && PRIO[item.priority] != null ? item.priority : "normal"; }
export function typeOf(item: Item): string { return TYPE_LABEL[item.type] ? item.type : "info"; }

// The same set the server validates decide against (shared/choices.ts).
export function baseOptions(item: Item): { list: OptionView[]; implied: boolean } { return baseChoices(item); }
export function optionsFor(item: Item): { list: OptionView[]; implied: boolean } {
  const b = baseOptions(item);
  const github = isReviewAsk(item) && !b.list.some((o) => o.id === GITHUB.id) ? [GITHUB] : [];
  return { list: b.list.concat(github, [OTHER]), implied: b.implied };
}
export function labelFor(item: Item, choice: string | null | undefined): string {
  if (!choice) return "";
  if (choice === "other") return "Other";
  if (choice === GITHUB.id && !baseOptions(item).list.some((o) => o.id === GITHUB.id)) return GITHUB.label;
  if (choice === "override") return "Overridden";
  const o = baseOptions(item).list.find((x) => x.id === choice);
  return o ? (o.label || choice) : Object.hasOwn(ENDED, choice) ? ENDED[choice] : choice;
}
// How an item ended without an answer: its asker withdrew it (POST /items/:id/withdraw), or the GitHub hook closed it
// with its PR. The server says so in decision.ended, so an option that happens to share the id can't pass for one.
// Hook closures from before `ended` are known by their author.
const ENDED: Record<string, string> = { withdrawn: "Withdrawn", merged: "PR merged", closed: "PR closed" };
export function endedChoice(item: Item): string | null {
  const d = item.decision;
  if (!d || isAuto(item)) return null;
  if (typeof d.ended === "string" && Object.hasOwn(ENDED, d.ended)) return d.ended;
  return d.by === "hook:github" && (d.choice === "merged" || d.choice === "closed") ? d.choice : null;
}
// What the decision panel and the timeline name: how it ended, else the chosen option's label.
export function decisionLabel(item: Item): string {
  const ended = endedChoice(item);
  return ended ? ENDED[ended] : labelFor(item, item.decision?.choice);
}

export function isOpen(item: Item): boolean { return (item.status || "open") === "open"; }
// A 409 on a decision pinned to the version shown: still open means it changed under the human (they review and decide again);
// otherwise someone else got there first.
export function decideConflict(shown: Item, current: Item): { changed: boolean; msg: string } {
  if (isOpen(current)) return { changed: true, msg: "This item changed since you opened it — review and decide again." };
  const who = current.decision && current.decision.choice ? " (" + labelFor(shown, current.decision.choice) + ")" : "";
  return { changed: false, msg: "Already " + (current.status || "closed") + who + " elsewhere." };
}
// auto_decided: an agent already made the call and is telling the user (FYI), so it never counts as an ask.
export function isAuto(item: Item): boolean { return item.type === "auto_decided"; }
export function isAsk(item: Item): boolean { return isOpen(item) && !isAuto(item); }
// The agent's own choice; after an override it lives in override_of.
export function agentChoice(item: Item): string | undefined {
  const d = item.decision;
  return d && d.choice === "override" ? item.override_of : d?.choice;
}

export interface Rec { option: string; confidence: Confidence | null; why: string; full: boolean }
// Briefing helpers. recommendation.option is an option id; an unknown value renders as written.
export function recOf(item: Item): Rec | null {
  const r = item.recommendation;
  if (r && typeof r === "object" && r.option) {
    return { option: String(r.option), confidence: r.confidence && CONF_LABEL[r.confidence] ? r.confidence : null, why: r.why || "", full: true };
  }
  return item.recommended ? { option: String(item.recommended), confidence: null, why: "", full: false } : null;
}
export function confChip(conf: Confidence | null, long = false): string {
  return conf ? '<span class="conf ' + conf + '" title="' + esc(CONF_LABEL[conf]) + '">' + esc(long ? CONF_LABEL[conf] : CONF_SHORT[conf]) + "</span>" : "";
}
export function prChip(item: Item, short = false): string {
  const s = item.pr_state;
  if (!s || !PR_LABEL[s]) return "";
  return '<span class="chip prs ' + esc(s) + '" title="' + esc(PR_LABEL[s]) + '">' + esc(short ? PR_SHORT[s] : PR_LABEL[s]) + "</span>";
}
export function headlineOf(item: Item): string { return (typeof item.question === "string" && item.question.trim()) || item.title || "(untitled)"; }
export function hasBriefing(item: Item): boolean { return !!(item.context || item.steps || item.command || item.question || item.recommendation || item.cost_of_waiting || Array.isArray(item.evidence)); }

// "answered": the manager's reply (qa_answered_at) is newer than the user's last question and the viewer's last look.
export function answeredAt(item: Item): number {
  if (item.qa_pending) return NaN;
  const a = toMs(item.qa_answered_at), q = toMs(item.qa_last_at);
  if (isNaN(a) || (!isNaN(q) && q > a)) return NaN;
  return a;
}
export function isAnswered(item: ItemRow, seen: Record<string, number>): boolean {
  const a = answeredAt(item); if (isNaN(a)) return false;
  return !(seen[item.id] >= a);
}

// Snoozed by the signed-in human (POST /api/items/:id/snooze; the row's snoozed_until is theirs, see flattenItem):
// an open item hidden from their Inbox, its counts and the triage order until that time passes. Per person:
// teammates still see it, and for the API it is simply open.
export function isSnoozed(item: ItemRow, now = Date.now()): boolean {
  return isOpen(item) && toMs(item.snoozed_until) > now;
}
export function openItems(items: ItemRow[], now = Date.now()): ItemRow[] {
  return items.filter((i) => isAsk(i) && !isSnoozed(i, now)).sort((a, b) => {
    const pa = PRIO[prioOf(a)], pb = PRIO[prioOf(b)];
    if (pa !== pb) return pa - pb;
    return (toMs(a.created_at) || 0) - (toMs(b.created_at) || 0);
  });
}
export function fyiItems(items: ItemRow[], now = Date.now()): ItemRow[] {
  return items.filter((i) => isOpen(i) && isAuto(i) && !isSnoozed(i, now)).sort((a, b) => (toMs(b.created_at) || 0) - (toMs(a.created_at) || 0));
}
// The Inbox's Snoozed group: soonest wake first.
export function snoozedItems(items: ItemRow[], now = Date.now()): ItemRow[] {
  return items.filter((i) => isSnoozed(i, now)).sort((a, b) => toMs(a.snoozed_until) - toMs(b.snoozed_until));
}
// What the header badge, the tab title and the Snoozed group count.
export function inboxCounts(items: ItemRow[], now = Date.now()): { need: number; fyi: number; snoozed: number } {
  return { need: openItems(items, now).length, fyi: fyiItems(items, now).length, snoozed: snoozedItems(items, now).length };
}
// processing = the manager claimed a decided item and is acting on it; it reads like decided.
export function pastItems(items: ItemRow[]): ItemRow[] {
  // Each item's time parsed once, not once per comparison (History can hold thousands).
  return items.filter((i) => i.status === "decided" || i.status === "processing" || i.status === "archived")
    .map((i) => ({ i, t: toMs(i.decision?.decided_at || i.updated_at) || 0 }))
    .sort((a, b) => b.t - a.t).map((x) => x.i);
}
export function sortedOrchs(orchs: OrchRow[]): OrchRow[] {
  return orchs.slice().sort((a, b) => {
    const sa = ORCH_ORDER[a.status ?? ""] ?? 9, sb = ORCH_ORDER[b.status ?? ""] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
}

// Evidence falls back to links for items written before the briefing fields existed.
export function evidenceOf(item: Item): { label?: string; url?: string }[] {
  const ev = Array.isArray(item.evidence) ? item.evidence.filter((l) => l && /^https?:\/\//i.test(String(l.url))) : [];
  return ev.length ? ev : (Array.isArray(item.links) ? item.links : []);
}

/* ---------- assignee: who an item is routed to (routing only; anyone can still decide) ---------- */
export type AssigneeFilter = "all" | "mine" | "unassigned";
export const ASSIGNEE_FILTERS: AssigneeFilter[] = ["all", "mine", "unassigned"];
export function isAssigneeFilter(v: unknown): v is AssigneeFilter { return ASSIGNEE_FILTERS.includes(v as AssigneeFilter); }
// Mine = assigned to the signed-in email (none for a token, which has no email).
export function filterAssignee(items: ItemRow[], f: AssigneeFilter, me: string | null): ItemRow[] {
  if (f === "unassigned") return items.filter((i) => !i.assignee);
  if (f === "mine") { const m = (me || "").toLowerCase(); return m ? items.filter((i) => (i.assignee || "").toLowerCase() === m) : []; }
  return items;
}
// Assignee UI (the Inbox filter, the item page's control) appears once someone is assigned or has set up
// notifications, so a one-person inbox looks as it always did.
export function assigneesInUse(items: ItemRow[], people: Person[]): boolean {
  return people.length > 0 || items.some((i) => !!i.assignee);
}
// Where an item's pushes go, when that isn't simply "to its assignee". Silent until someone has a personal
// topic: before that every push goes to the deployment's one topic, as it always did.
export function pushNote(assignee: string | undefined, people: Person[]): string {
  if (!people.some((p) => p.has_topic)) return "";
  if (!assignee) return "pushes go to everyone";
  const p = people.find((x) => x.email === assignee.toLowerCase());
  return p && p.has_topic ? "" : "no ntfy topic: pushes go to everyone";
}
// The display name a person set in Settings, else the part of the email before the @.
export function personName(email: string, people: Person[]): string {
  const e = email.toLowerCase(), p = people.find((x) => x.email === e);
  return (p && p.name) || email.split("@")[0];
}
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

/* ---------- index rows: the meta line under a row's headline (src/views/rows.ts draws it) ---------- */
// What a row's one meta line says, in order; the view turns each part into markup and the line ellipsizes at its end.
export type MetaPart =
  | { k: "type"; text: string } // the item's type: Decision, Blocker… ("Decided for you" for an FYI without a choice)
  | { k: "chose"; who: string; text: string } // FYI: "O2 chose" and the agent's choice
  | { k: "verdict"; text: string; handling: boolean } // past: Decided / Accepted / Overridden / Archived / Being handled
  | { k: "choice"; text: string; choice: string } // past: what was chosen ("No decision" when archived without one)
  | { k: "orch"; text: string } // the orchestrator's id, or "Manager" for the manager's own items
  | { k: "who"; me: boolean; name: string; initials: string; email: string } // the assignee
  | { k: "answered" } // the manager answered the viewer's question since their last look
  | { k: "asked" } // a question waiting for the manager
  | { k: "conf"; conf: Confidence; text: string } // the recommendation's confidence (wide layouts only)
  | { k: "pr" } // the PR's state (prChip)
  | { k: "wake"; until: string }; // snoozed: when it comes back

export interface RowMetaOpts {
  past?: boolean; fyi?: boolean; snoozed?: boolean; hideOrch?: boolean;
  me: string | null; people: Person[]; seen: Record<string, number>;
}
// The row's type word: TYPE_LABEL, except an FYI reads "Decided for you".
export const ROW_TYPE: Record<string, string> = { ...TYPE_LABEL, auto_decided: "Decided for you" };

// A past row's verdict word and what was chosen, as the item page's verdict panel names them.
export function verdictOf(item: Item): { verdict: string; label: string; choice: string } {
  const d = item.decision, ovr = isAuto(item) && !!d && d.choice === "override";
  const choice = ovr ? "override" : (isAuto(item) ? agentChoice(item) : d?.choice) || "";
  const label = ovr ? oneLine(d?.note) : choice ? decisionLabel(item) : "";
  // Claimed by the manager comes first, an override too, as on the item page's verdict panel.
  if (item.status === "processing") return { verdict: "Being handled", label, choice };
  if (ovr) return { verdict: "Overridden", label, choice };
  if (isAuto(item)) return { verdict: item.status === "archived" ? "Accepted" : "Closed", label, choice };
  // Withdrawn: the reason is the note. Closed with its PR: whether it merged.
  const ended = endedChoice(item);
  if (ended === "withdrawn") return { verdict: "Withdrawn", label: oneLine(d?.note), choice };
  if (ended) return { verdict: "Closed", label, choice };
  return { verdict: choice ? "Decided" : "Archived", label: label || "No decision", choice };
}
function oneLine(s: unknown): string { return typeof s === "string" ? s.trim().split(/\r?\n/)[0] : ""; }

export function rowMeta(item: ItemRow, opts: RowMetaOpts): MetaPart[] {
  const parts: MetaPart[] = [];
  const orch = item.orchestrator || "Orchestrator";
  if (opts.snoozed) {
    if (item.snoozed_until) parts.push({ k: "wake", until: item.snoozed_until });
  } else if (opts.past) {
    const v = verdictOf(item);
    parts.push({ k: "verdict", text: v.verdict, handling: item.status === "processing" });
    if (v.label) parts.push({ k: "choice", text: v.label, choice: v.choice });
    if (!opts.hideOrch) parts.push({ k: "orch", text: orch });
  } else if (opts.fyi) {
    const ac = agentChoice(item);
    if (ac) parts.push({ k: "chose", who: orch, text: labelFor(item, ac) });
    else {
      parts.push({ k: "type", text: ROW_TYPE.auto_decided });
      if (!opts.hideOrch) parts.push({ k: "orch", text: orch });
    }
  } else {
    parts.push({ k: "type", text: ROW_TYPE[typeOf(item)] });
    if (!opts.hideOrch) parts.push({ k: "orch", text: orch });
  }
  if (item.assignee) {
    const me = !!opts.me && item.assignee.toLowerCase() === opts.me.toLowerCase(), name = personName(item.assignee, opts.people);
    parts.push({ k: "who", me, name, initials: initials(name), email: item.assignee });
  }
  if (isAnswered(item, opts.seen)) parts.push({ k: "answered" });
  if (item.qa_pending) parts.push({ k: "asked" });
  if (opts.snoozed) return parts;
  if (!opts.past && !opts.fyi) {
    const rc = recOf(item);
    if (rc && rc.full && rc.confidence) parts.push({ k: "conf", conf: rc.confidence, text: CONF_LABEL[rc.confidence] });
  }
  if (item.pr_state && PR_LABEL[item.pr_state]) parts.push({ k: "pr" });
  return parts;
}

export function itemHref(id: string): string { return "#item." + encodeURIComponent(id); }
export function orchHref(id: string): string { return "#orch." + encodeURIComponent(id); }
