// The Reviews tab's view model (docs/reviews.md): pure functions from a routine's runs and PRs to what the tab shows.
// It groups PRs by what they wait on, says what the last run did and builds the run feed from the API's shapes, with the
// schedule's zone for times and the routine's own next_run_at. Everything in a report is untrusted PR text: the views
// escape it; here only urls are checked.
import type {
  ReviewAction, ReviewEvent, ReviewPr, ReviewPrResponse, ReviewPrRow, ReviewRoutineHead, ReviewRun, ReviewStatus, RoutineState,
} from "../../shared/types.ts";
import { liveRun, requestPending } from "../../shared/reviews.ts";
import { itemHref, labelFor, type ItemRow } from "./items.ts";
import type { Route } from "../state.ts";
import { dayKey, slotTime, toMs, zoneClock } from "./time.ts";

export type Glyph = "you" | "held" | "changes" | "waiting" | "required" | "approved" | "draft" | "bot" | "commented" | "checked" | "skipped";

// The report's status taxonomy (docs/reviews.md "The report"): the label, the row's mark, and what clears the status.
export const STATUS: Record<ReviewStatus, { label: string; glyph: Glyph; clears: string }> = {
  awaiting_ok: { label: "Awaiting your OK", glyph: "you", clears: "Clears when you decide its ask in the Inbox." },
  held_product: { label: "Held · product call", glyph: "held", clears: "Clears when you comment or review." },
  held_owner: { label: "Held · owner's area", glyph: "held", clears: "Clears when the code owner approves or asks for your approval." },
  held_ci: { label: "Held · CI", glyph: "held", clears: "Clears when CI finishes green on the current head." },
  changes_requested: { label: "Changes requested", glyph: "changes", clears: "Clears when the author pushes a fix and a run re-reviews it." },
  waiting_author: { label: "Waiting on author", glyph: "waiting", clears: "Clears when the author pushes or replies." },
  pending: { label: "Pending review", glyph: "required", clears: "Clears when a run reviews it." },
  approved: { label: "Approved", glyph: "approved", clears: "Nothing left: it drops off when merged or closed." },
  mine_action: { label: "Needs your action", glyph: "changes", clears: "Clears when you push, reply or fix CI." },
  mine_waiting: { label: "Review required", glyph: "required", clears: "Waiting on reviewers." },
  mine_ready: { label: "Ready to merge", glyph: "approved", clears: "Approved, CI green, mergeable." },
  mine_draft: { label: "Draft", glyph: "draft", clears: "A draft: not in review yet." },
  bot: { label: "Bot PR", glyph: "bot", clears: "The routine doesn't review bot PRs." },
};

// Every current PR shows in one group: needs_you wins, then the role, then the status. Mine and Bots fold.
export type GroupId = "needs" | "held" | "author" | "approved" | "mine" | "bots";
export const GROUPS: { id: GroupId; label: string; order: ReviewStatus[]; fold?: boolean; empty?: string }[] = [
  { id: "needs", label: "Needs you", order: ["held_product"] },
  { id: "held", label: "Held", order: ["awaiting_ok", "held_product", "held_owner", "held_ci"], empty: "Nothing waiting on your OK, a code owner or CI. Product calls sit under Needs you." },
  { id: "author", label: "With author", order: ["changes_requested", "waiting_author", "pending"] },
  { id: "approved", label: "Approved", order: ["approved"] },
  { id: "mine", label: "Mine", order: ["mine_action", "mine_ready", "mine_waiting", "mine_draft"], fold: true },
  { id: "bots", label: "Bots", order: ["bot"], fold: true },
];

// A run's action on a PR: the feed's verb (short) and the PR line's (long).
export const ACTION: Record<ReviewAction, { label: string; long?: string; glyph: Glyph; quiet?: boolean }> = {
  approved: { label: "Approved", glyph: "approved" },
  changes_requested: { label: "Req. changes", long: "Requested changes", glyph: "changes" },
  commented: { label: "Commented", glyph: "commented", quiet: true },
  drafted: { label: "Drafted", long: "Drafted, awaiting your OK", glyph: "you" },
  replied: { label: "Replied", glyph: "commented", quiet: true },
  none: { label: "Checked", long: "No action", glyph: "checked", quiet: true },
};
export const RESULT: Record<string, string> = { ok: "OK", seed: "Imported", running: "Running", failed: "Failed", timed_out: "Timed out", report_invalid: "Report invalid" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? v : []);
const prNum = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);
const ms = (t: unknown): number | null => { const x = toMs(t); return isNaN(x) ? null : x; };
// https only: a review link is PR content.
export function httpsUrl(u: unknown): string | null {
  const s = str(u);
  if (!/^https:\/\//i.test(s)) return null;
  try { return new URL(s).protocol === "https:" ? s : null; } catch { return null; }
}

/* ---------- PRs ---------- */
export const isBot = (pr: ReviewPr): boolean => pr.role === "bot" || pr.status === "bot";
export const isMine = (pr: ReviewPr): boolean => !isBot(pr) && (pr.role === "mine" || (pr.role !== "reviewing" && /^mine_/.test(str(pr.status))));
export const needsYou = (pr: ReviewPr): boolean => isObj(pr.needs_you);

// The status a PR shows: its own when it fits its role, else the role's default.
export function statusOf(pr: ReviewPr): ReviewStatus {
  if (isBot(pr)) return "bot";
  const s = str(pr.status) as ReviewStatus, known = s in STATUS;
  if (isMine(pr)) return known && /^mine_/.test(s) ? s : "mine_waiting";
  return known && !/^mine_|^bot$/.test(s) ? s : "pending";
}
export function groupOf(pr: ReviewPr): GroupId {
  if (needsYou(pr)) return "needs";
  if (isBot(pr)) return "bots";
  if (isMine(pr)) return "mine";
  const s = statusOf(pr);
  return /^held_|^awaiting_ok$/.test(s) ? "held" : s === "approved" ? "approved" : "author";
}
// When the routine last moved on it, else when the PR last changed.
function recentOf(pr: ReviewPr): number {
  return ms(isObj(pr.last_action) ? pr.last_action.at : null) ?? ms(pr.updated_at) ?? ms(pr.created_at) ?? 0;
}
// Needs you lists the PRs I review first, then mine, then bots.
const roleRank = (pr: ReviewPr) => (isBot(pr) ? 2 : isMine(pr) ? 1 : 0);

// The current PRs (not the ones gone from the newest report) by group, each in its group's order.
export function groupPrs(rows: ReviewPrRow[]): Record<GroupId, ReviewPrRow[]> {
  const out = Object.fromEntries(GROUPS.map((g) => [g.id, [] as ReviewPrRow[]])) as Record<GroupId, ReviewPrRow[]>;
  for (const r of rows) if (!r.gone_at && isObj(r.data)) out[groupOf(r.data)].push(r);
  for (const g of GROUPS) {
    const rank = (r: ReviewPrRow) => { const i = g.order.indexOf(statusOf(r.data)); return i < 0 ? 9 : i; };
    out[g.id].sort((a, b) => (g.id === "needs" ? roleRank(a.data) - roleRank(b.data) : 0) || rank(a) - rank(b) ||
      recentOf(b.data) - recentOf(a.data) || b.number - a.number);
  }
  return out;
}

export function glyphOf(pr: ReviewPr): Glyph {
  if (needsYou(pr)) return "you";
  if (isBot(pr)) return isObj(pr.last_action) && pr.last_action.kind === "approved" ? "approved" : "bot";
  return STATUS[statusOf(pr)].glyph;
}

// "What clears it", under the status in the PR pane.
export function clearsText(pr: ReviewPr): string {
  return needsYou(pr) ? "Clears when you make the call or review on GitHub." : STATUS[statusOf(pr)].clears;
}

// What a PR line needs from the runs: the newest report's same-patch skips, and when that run started.
export interface LineCtx { samePatch: Set<number>; latestAt: number | null }
export function lineCtx(runs: ReviewRun[]): LineCtx {
  const r = runs.find((x) => x.has_report);
  const same = r ? arr(isObj(r.data.skipped) ? r.data.skipped.same_patch : null).map(prNum).filter((n): n is number => n !== null) : [];
  return { samePatch: new Set(same), latestAt: r ? ms(r.started_at) : null };
}

// The routine's latest move on the PR and when (`opened`: a bot PR's date is when it opened), for its row.
export function lastLine(row: ReviewPrRow, ctx: LineCtx): { text: string; at: number | null; opened?: true } {
  const pr = row.data, t = isObj(pr.this_run) ? pr.this_run : { action: "none" as ReviewAction }, la = isObj(pr.last_action) ? pr.last_action : {};
  const action = t.action in ACTION ? t.action : "none", runAt = ms(stampIso(row.last_stamp));
  if (isBot(pr)) {
    const bits = [la.kind === "approved" ? "Approved earlier, unmerged" : action !== "none" ? ACTION[action].long || ACTION[action].label : "Not reviewed"];
    if (pr.mergeable === "conflicts") bits.push("conflicts");
    if (pr.mergeable === "behind") bits.push("behind base");
    return { text: bits.join(", "), at: ms(pr.created_at) ?? ms(pr.updated_at), opened: true };
  }
  if (isMine(pr)) {
    const bits = [STATUS[statusOf(pr)].label], open = Number(isObj(pr.threads) ? pr.threads.open : 0) || 0;
    if (isObj(pr.ci) && pr.ci.state === "failing") bits.push("CI failing");
    if (pr.mergeable === "conflicts") bits.push("conflicts");
    if (open) bits.push(open + " open thread" + (open === 1 ? "" : "s"));
    return { text: bits.join(", "), at: ms(pr.updated_at) };
  }
  if (action !== "none") return { text: ACTION[action].long || ACTION[action].label, at: (la.kind === action ? ms(la.at) : null) ?? runAt };
  if (ctx.samePatch.has(row.number)) return { text: "Skipped rebase", at: ctx.latestAt };
  if (arr(t.changes).length) return { text: /^held_|^awaiting_ok$/.test(statusOf(pr)) || needsYou(pr) ? "Checked, still held" : "Checked, nothing posted", at: runAt };
  const kind = str(la.kind) as ReviewAction;
  if (kind in ACTION) return { text: ACTION[kind].long || ACTION[kind].label, at: ms(la.at) };
  return { text: STATUS[statusOf(pr)].label, at: null };
}

/* ---------- runs ---------- */
// "2026-10-08T181500Z" → its ISO time ("" for anything else).
export function stampIso(stamp: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(str(stamp));
  return m ? m[1] + "T" + m[2] + ":" + m[3] + ":" + m[4] + "Z" : "";
}

export interface FeedRow { n: number; glyph: Glyph; verb: string; quiet: boolean; you: boolean; what: string; url: string | null }
export interface FeedRun {
  stamp: string; started: number | null; finished: number | null; ok: boolean; running: boolean; dry: boolean; result: string;
  exit: number | null; error: string; headline: string; log: string; rows: FeedRow[]; stale: number; unverified: string[]; notes: string[];
}
// One entry per run, newest first. Rows: its actions, then needs-you PRs it didn't act on, then same-patch skips.
export function runFeed(runs: ReviewRun[]): FeedRun[] {
  return runs.map((r) => {
    const d = isObj(r.data) ? r.data : ({} as ReviewRun["data"]), rows: FeedRow[] = [], seen = new Set<number>();
    for (const a of arr<Record<string, unknown>>(d.actions).filter(isObj)) {
      const n = prNum(a.pr); if (!n || seen.has(n)) continue;
      seen.add(n);
      const def = ACTION[a.action as ReviewAction] || { label: str(a.action) || "Acted", glyph: "commented" as Glyph, quiet: true };
      rows.push({ n, glyph: def.glyph, verb: def.label, quiet: !!def.quiet, you: false, what: str(a.summary) || str(a.title), url: httpsUrl(a.url) });
    }
    for (const a of arr<Record<string, unknown>>(d.needs_you).filter(isObj)) {
      const n = prNum(a.pr); if (!n || seen.has(n)) continue;
      seen.add(n);
      rows.push({ n, glyph: "you", verb: "Needs you", quiet: false, you: true, what: str(a.ask) || str(a.title), url: null });
    }
    const sk = isObj(d.skipped) ? d.skipped : {};
    for (const x of arr(sk.same_patch)) {
      const n = prNum(x); if (!n || seen.has(n)) continue;
      seen.add(n);
      rows.push({ n, glyph: "skipped", verb: "Skipped", quiet: true, you: false, what: "same-patch rebase", url: null });
    }
    return {
      stamp: r.stamp, started: ms(r.started_at) ?? ms(stampIso(r.stamp)), finished: ms(r.finished_at), ok: r.result === "ok" || r.result === "seed",
      running: r.result === "running", dry: !!r.dry, result: RESULT[r.result] || str(r.result) || "Unknown",
      exit: Number.isSafeInteger(d.exit) ? d.exit : null, error: str(d.error), headline: str(d.headline), log: str(d.log), rows,
      stale: arr(sk.stale).length, unverified: arr(d.unverified).map(str).filter(Boolean), notes: arr(d.notes).map(str).filter(Boolean),
    };
  });
}

// Runs started today in the zone (the Runs toggle's "2 today").
export function runsToday(runs: ReviewRun[], tz: string, now = Date.now()): number {
  const today = dayKey(now, tz);
  return runs.filter((r) => dayKey(r.started_at || stampIso(r.stamp), tz) === today).length;
}

// "14:15" today, "Tue" this week, "29 Sep" before that: a PR line's time.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortWhen(t: number | null, tz: string, now = Date.now()): string {
  if (t == null || isNaN(t)) return "";
  const day = dayKey(t, tz);
  if (day === dayKey(now, tz)) return zoneClock(t, tz);
  const [y, m, d] = day.split("-").map(Number), [ty, tm, td] = dayKey(now, tz).split("-").map(Number);
  const back = (Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86400000;
  return back > 0 && back < 7 ? DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] : d + " " + MONTHS[m - 1] + (y === ty ? "" : " " + y);
}

// The routine card's status line, like the manager's (src/lib/status.ts): kind drives the dot.
const OVERDUE_MS = 20 * 60000;
export function routineStatus(head: ReviewRoutineHead | null, runs: ReviewRun[], tz: string, now = Date.now()): { kind: "ok" | "warn" | "pending" | "unknown"; text: string } {
  const newest = runs[0], last = runs.find((r) => r.result !== "running");
  if (newest && newest.result === "running") return { kind: "pending", text: "Running since " + slotTime(newest.started_at, tz, now) };
  const next = ms(head && head.next_run_at);
  if (next !== null && next < now - OVERDUE_MS) return { kind: "warn", text: "Run overdue since " + slotTime(next, tz, now) };
  if (!last) return { kind: "unknown", text: "No runs yet" };
  if (last.result !== "ok" && last.result !== "seed") {
    return { kind: "warn", text: "Last run " + (RESULT[last.result] || last.result).toLowerCase() + " at " + slotTime(last.finished_at || last.started_at, tz, now) };
  }
  const span = slotTime(last.started_at, tz, now) + (last.finished_at ? "–" + zoneClock(last.finished_at, tz) : "");
  return { kind: "ok", text: "Last run " + span + (next !== null ? " · next " + slotTime(next, tz, now) : "") };
}

/* ---------- the Run button (docs/reviews.md "Run requests") ---------- */
// What the routine card's Run button shows: whether it's held (a request waiting on the runner's poller, or a run going), its
// label, and one line on the newest request. `run`: a run stamp the line links to. `warn`: the request went wrong.
export interface RunAsk { busy: boolean; label: string; note: string | null; warn: boolean; run: string | null }
export function runAsk(head: ReviewRoutineHead | null, runs: ReviewRun[], tz: string, now = Date.now()): RunAsk {
  const req = head?.run_request ?? null, idle = /-dry$/.test(head?.routine ?? "") ? "Run dry review" : "Run bot review";
  const at = (t: string) => slotTime(t, tz, now);
  const live = liveRun(runs, head?.last_stamp ?? null, now);
  if (req && requestPending(req, now)) {
    return req.status === "requested"
      ? { busy: true, label: "Requested", note: "Asked at " + at(req.requested_at) + " · waiting for the runner to pick it up", warn: false, run: null }
      : { busy: true, label: "Starting", note: "Picked up at " + at(req.updated_at) + (req.message ? " · " + req.message : ""), warn: false, run: null };
  }
  if (live) {
    const mine = req?.status === "started" && req.stamp === live.stamp;
    return { busy: true, label: "Running", note: (mine ? "Your run started " : "A run is going since ") + at(live.started_at), warn: false, run: live.stamp };
  }
  const base = { busy: false, label: idle, run: null };
  if (!req) return { ...base, note: null, warn: false };
  if (req.status === "requested" || req.status === "starting") {
    return { ...base, note: "The runner didn't start the run asked for at " + at(req.requested_at) + ". Is its poller running?", warn: true };
  }
  if (req.status === "skipped") return { ...base, note: "Skipped at " + at(req.updated_at) + ": " + (req.message || "a run was already going"), warn: true };
  if (req.status === "failed") return { ...base, note: "Couldn't start at " + at(req.updated_at) + (req.message ? ": " + req.message : ""), warn: true };
  // Started: the run it started, when the loaded runs still hold it.
  const run = runs.find((r) => r.stamp === req.stamp);
  if (!run) return { ...base, note: "Started run " + req.stamp + " at " + at(req.updated_at), warn: false, run: req.stamp };
  if (run.result === "running") return { ...base, note: "The run from " + at(run.started_at) + " never reported back", warn: true, run: run.stamp };
  const ok = run.result === "ok" || run.result === "seed";
  return { ...base, note: "Requested run " + (ok ? "finished" : (RESULT[run.result] || run.result).toLowerCase()) + " at " + at(run.finished_at || run.started_at), warn: !ok, run: run.stamp };
}

/* ---------- routines and routes ---------- */
// The routine the tab shows: the one asked for (#reviews.<routine>, or saved) if it has reported, else the first (by id)
// that isn't a dry run (an id ending in -dry), else the first.
export function pickRoutine(routines: RoutineState[], want: string | null): string | null {
  const ids = routines.map((r) => r.id);
  if (want && ids.includes(want)) return want;
  return ids.find((id) => !/-dry$/.test(id)) ?? ids[0] ?? null;
}

// Whether the routine shown must be (re)fetched: nothing loaded for it yet, or its head's version in /api/state (the
// delta replaces `routines` whenever a routine changed) has moved past the one loaded.
export function reviewsStale(routines: RoutineState[], routine: string | null, loaded: { routine: string; version: number } | null): boolean {
  if (!routine) return false;
  if (!loaded || loaded.routine !== routine) return true;
  const head = routines.find((r) => r.id === routine);
  return !!head && head.version !== loaded.version;
}

// A PR page's own fetch (GET /api/reviews/:routine/prs/:n), as state.reviews.prs keeps it: what the page shows from it,
// and whether to fetch it (again): nothing yet, or the routine's head (`head`) has moved past the version fetched. A
// fetch in flight keeps showing what it had, on every render until it lands, so a gone PR (not in the list) never
// drops back to the skeleton mid-refresh.
export interface PrFetch { version: number | null; state: "loading" | "ok" | "missing" | "failed"; data: ReviewPrResponse | null }
export function prFetchView(got: PrFetch | undefined, head: number | null): { show: ReviewPrResponse | "loading" | "missing" | "failed"; fetch: boolean } {
  if (got && got.state === "loading") return { show: got.data ?? "loading", fetch: false };
  if (got && got.version === head) return { show: got.state === "ok" ? got.data ?? "failed" : got.state, fetch: false };
  return { show: got?.data ?? "loading", fetch: true };
}

// Plain-token hashes like #item.<id>: #reviews.<routine>, #run[.<routine>].<stamp>, #pr[.<routine>].<n>. A routine
// id is an orchestrator id, so it may hold dots: the stamp or number is the last part.
const ROUTINE = "[A-Za-z0-9][A-Za-z0-9._:-]*", STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{6}Z";
const REVIEWS_RE = new RegExp("^\\/?reviews\\.(" + ROUTINE + ")$"), RUN_RE = new RegExp("^\\/?run\\.(?:(" + ROUTINE + ")\\.)?(" + STAMP + ")$");
const PR_RE = new RegExp("^\\/?pr\\.(?:(" + ROUTINE + ")\\.)?([1-9]\\d{0,8})$");
export function parseReviewHash(h: string): Route | null {
  let m: RegExpMatchArray | null;
  if ((m = h.match(REVIEWS_RE))) return { view: "tab", tab: "reviews", routine: m[1] };
  if ((m = h.match(RUN_RE))) return { view: "run", routine: m[1] ?? null, stamp: m[2] };
  if ((m = h.match(PR_RE))) return { view: "pr", routine: m[1] ?? null, n: Number(m[2]) };
  return null;
}
// A run or PR page's own link, its routine always named (the one shown when the link had none), so a list row, the
// selected row and j / k agree whichever routine was saved last. null for any other page.
export function routeHref(r: Route, current: string | null): string | null {
  if (r.view === "run") return runHref(r.stamp, r.routine ?? current);
  if (r.view === "pr") return prHref(r.n, r.routine ?? current);
  return null;
}
// A live refresh replaces the newest page; runs it pushed out would leave a gap above the older pages already loaded.
// This refetches from the newest page's end down to the oldest run loaded (pages of runs before a stamp, as
// GET /api/reviews/:routine?before= serves them), so the window stays continuous, and keeps whether more lie below.
export async function refillOlder(
  newest: ReviewRun[], older: { runs: ReviewRun[]; more: boolean | null },
  fetchPage: (before: string) => Promise<{ runs: ReviewRun[]; more: boolean }>,
): Promise<{ runs: ReviewRun[]; more: boolean | null }> {
  const floor = older.runs[older.runs.length - 1], end = newest[newest.length - 1];
  if (!floor || !end) return older;
  const got: ReviewRun[] = [];
  let before = end.stamp, more = false;
  for (;;) {
    const p = await fetchPage(before), last = p.runs[p.runs.length - 1];
    got.push(...p.runs); more = p.more;
    if (!last || last.stamp <= floor.stamp || !p.more) break;
    before = last.stamp;
  }
  return { runs: got.filter((r) => r.stamp >= floor.stamp), more: more || got.some((r) => r.stamp < floor.stamp) };
}

// The routine card's one action: with exactly one PR needing you, its ask in the Inbox (or the PR itself when it has
// none); with more, the Needs you group (the card's "N need you"); none with nothing needing you.
export function cardAction(needs: ReviewPrRow[], asks: ItemRow[], routine: string): { kind: "button"; text: string; href: string } | { kind: "group" } | null {
  if (needs.length > 1) return { kind: "group" };
  const n = needs[0]?.number;
  if (!n) return null;
  const open = asksFor(asks, routine, n).find((i) => (i.status || "open") === "open");
  return open ? { kind: "button", text: "Decide in Inbox", href: itemHref(open.id) } : { kind: "button", text: "Open #" + n, href: prHref(n, routine) };
}

// The newest page of runs, then older pages Load older fetched (?before=): each run once, newest first.
export function mergeRuns(newest: ReviewRun[], older: ReviewRun[]): ReviewRun[] {
  const seen = new Set<string>();
  return [...newest, ...older].filter((r) => !seen.has(r.stamp) && !!seen.add(r.stamp)).sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}
export const runHref = (stamp: string, routine?: string | null) => "#run." + (routine ? encodeURIComponent(routine) + "." : "") + stamp;
export const prHref = (n: number, routine?: string | null) => "#pr." + (routine ? encodeURIComponent(routine) + "." : "") + n;

/* ---------- a PR's pane: its asks in the Inbox, its header, its timeline ---------- */
// The PR an Inbox item asks about: `review_pr` as the runner sets it, else the runner's item id
// "<routine>-<pr>-<hold>" (then "-2", "-3" ...), for a routine that has reported.
// Only the routine's own items: the runner posts them with orchestrator = the routine, and no other orchestrator's item
// may stand in for one (its timeline, its asks, the PR page's Decide in Inbox).
export function reviewPrOf(item: ItemRow, routineIds: string[]): { routine: string; n: number } | null {
  const rp = isObj(item.review_pr) ? item.review_pr : null;
  if (rp) {
    const n = prNum(rp.number), routine = str(rp.routine);
    return n && routineIds.includes(routine) && item.orchestrator === routine ? { routine, n } : null;
  }
  for (const routine of routineIds) {
    if (item.orchestrator !== routine || !item.id.startsWith(routine + "-")) continue;
    const m = /^([1-9]\d{0,8})-[a-z][a-z0-9_]*(?:-\d+)?$/.exec(item.id.slice(routine.length + 1));
    if (m) return { routine, n: Number(m[1]) };
  }
  return null;
}
// The other PRs a shared product call covers (review_pr.also, docs/reviews.md): PR numbers only, each once.
export function alsoPrsOf(item: ItemRow): number[] {
  const rp = isObj(item.review_pr) ? item.review_pr : null;
  const out: number[] = [];
  for (const v of arr(rp?.also)) { const n = prNum(v); if (n && !out.includes(n)) out.push(n); }
  return out;
}
// The routine's items about PR n (its own PR, or one of a shared call's), newest first.
export function asksFor(items: ItemRow[], routine: string, n: number): ItemRow[] {
  return items.filter((i) => { const p = reviewPrOf(i, [routine]); return !!p && (p.n === n || alsoPrsOf(i).includes(n)); })
    .sort((a, b) => (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0));
}

// The pane's sticky header: the status, what clears it, and the one action. An open ask is decided in the Inbox; a
// decided one waits for the next run to post it on GitHub; otherwise the PR's own status, and GitHub.
export interface RvHead { chip: Glyph | "decided"; label: string; clears: string; action: { text: string; href: string; external: boolean } | null }
export function rvHead(row: ReviewPrRow, asks: ItemRow[], next: string | null, tz: string, now = Date.now()): RvHead {
  const pr = row.data, url = httpsUrl(pr.url), github = url ? { text: "Review on GitHub ↗", href: url, external: true } : null;
  const open = asks.find((i) => (i.status || "open") === "open");
  if (open) {
    return { chip: "you", label: "Needs you · " + STATUS[statusOf(pr)].label, clears: "Clears when you decide in the Inbox or review on GitHub.",
      action: { text: "Decide in Inbox", href: itemHref(open.id), external: false } };
  }
  const done = asks.find((i) => i.status === "decided" || i.status === "processing");
  if (done) {
    const at = ms(next);
    return { chip: "decided", label: "Decided · relays " + (at !== null && at > now ? "at " + slotTime(at, tz, now) : "next run"),
      clears: "You chose “" + labelFor(done, done.decision?.choice) + "”. The next run posts it on GitHub.", action: github };
  }
  return { chip: glyphOf(pr), label: (needsYou(pr) ? "Needs you · " : "") + STATUS[statusOf(pr)].label, clears: clearsText(pr), action: github };
}

// The PR's timeline, newest first: what each run did (and what it saw change), reviews GitHub reported since, and the
// routine's asks in the Inbox with how they ended. `who` drives the routine / author / you filter; others' reviews
// and decisions show under All only. `me`: the signed-in human's email.
export type TimelineWho = "routine" | "author" | "you" | "other";
export interface TimelineEntry { at: number | null; who: TimelineWho; verb: string; text: string; url: string | null; href: string | null }
export function prTimeline(row: ReviewPrRow, events: ReviewEvent[], asks: ItemRow[], me: string | null): TimelineEntry[] {
  const pr = row.data, out: TimelineEntry[] = [];
  const add = (at: unknown, who: TimelineWho, verb: string, text: string, url: string | null = null, href: string | null = null) =>
    out.push({ at: ms(at), who, verb, text, url, href });
  for (const ask of asks) {
    add(ask.created_at, "routine", "Asked you", str(ask.question) || ask.title || "", null, itemHref(ask.id));
    const d = ask.decision;
    if (!d || !d.decided_at) continue;
    if (d.ended === "withdrawn") add(d.decided_at, "routine", "Withdrew the ask", str(d.note), null, itemHref(ask.id));
    else if (d.ended) add(d.decided_at, "other", d.ended === "merged" ? "PR merged" : "PR closed", "", null, itemHref(ask.id));
    else if (me && str(d.by).toLowerCase() === "human:" + me.toLowerCase()) add(d.decided_at, "you", "You chose", labelFor(ask, d.choice), null, itemHref(ask.id));
    else add(d.decided_at, "other", "Decided", labelFor(ask, d.choice), null, itemHref(ask.id));
  }
  const gh = isObj(row.gh) ? row.gh : null;
  for (const r of arr<Record<string, unknown>>(gh && gh.reviews).filter(isObj)) {
    const login = str(r.login), state = str(r.state).toLowerCase().replace(/_/g, " ");
    if (login) add(r.at, login === pr.author ? "author" : "other", login + " " + (state || "reviewed"), "");
  }
  if (gh && gh.pushed_at) add(gh.pushed_at, "author", "Pushed", "New commits since the last run");
  for (const e of events) {
    const d = isObj(e.data) ? e.data : null; if (!d) continue;
    const at = d.at || stampIso(e.stamp), action = d.action in ACTION ? d.action : "none";
    if (action !== "none") add(at, "routine", ACTION[action].long || ACTION[action].label, str(d.summary), httpsUrl(d.review_url));
    for (const c of arr(d.changes).map(str).filter(Boolean)) add(at, "author", "Changed", c);
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => (b.e.at ?? 0) - (a.e.at ?? 0) || a.i - b.i).map((x) => x.e);
}
export type TimelineFilter = "all" | "routine" | "author" | "you";
export function filterTimeline(entries: TimelineEntry[], f: TimelineFilter): TimelineEntry[] {
  return f === "all" ? entries : entries.filter((e) => e.who === f);
}
