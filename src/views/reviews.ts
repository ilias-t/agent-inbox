import type { ReviewPr, ReviewPrResponse, ReviewPrRow, ReviewRoutineHead, ReviewRun, ReviewRunRequestResponse } from "../../shared/types.ts";
import { esc, toast } from "../lib/dom.ts";
import { itemHref, openItems, type ItemRow } from "../lib/items.ts";
import { inlineMd, md } from "../lib/md.ts";
import {
  GROUPS, STATUS, alsoPrsOf, asksFor, cardAction, mergeRuns, filterTimeline, glyphOf, groupPrs, httpsUrl, isBot, isMine, lastLine, lineCtx, needsYou, pickRoutine, prFetchView, prHref, prTimeline,
  reviewPrOf, reviewsStale, routineStatus, runAsk, runFeed, runHref, runsToday, rvHead, shortWhen, statusOf, type FeedRow, type FeedRun, type Glyph, type TimelineFilter,
} from "../lib/reviews.ts";
import { dayKey, dayLabel, relSpan, slotTime, toMs, zoneClock, zoneStamp } from "../lib/time.ts";
import { dayRuns } from "../lib/history.ts";
import { RunWindows } from "../lib/runwindow.ts";
import { ApiError, store } from "../store.ts";
import { myEmail, myRole, routines, scheduleZone, setReviewsView, state } from "../state.ts";
import { canAct } from "../lib/roles.ts";
import { skeleton } from "./rows.ts";
import { pinKey, pinPrs, splitPinned } from "../lib/pins.ts";
import { pinButton, pinSig, pinnedHead } from "./pins.ts";

/* ---------- the Reviews tab: a routine's runs and where every PR it tracks stands (docs/reviews.md) ---------- */
// The routine shown: the one asked for if it has reported, else the default (src/lib/reviews.ts pickRoutine).
export function currentRoutine(): string | null { return pickRoutine(routines(), state.reviews.want); }
// The loaded data, when it is the routine shown.
function shown() {
  const d = state.reviews.data, id = currentRoutine();
  return d && id && d.routine.routine === id ? d : null;
}

// Called when a fetch lands, to redraw what shows it (src/main.ts: the list, and a run or PR page).
let redraw = (): void => {};
export function onReviewsLoaded(fn: () => void): void { redraw = fn; }

// Fetches the routine shown when it's stale (src/lib/reviews.ts reviewsStale): only while the tab, or a run or PR
// page, is on screen; a hidden tab catches up when it's shown. `force`: Try again after a failure.
// `fetchedFor`: the routine's head version in /api/state when its data was last fetched. A saved snapshot's older
// version won't match what the server sent, so it's no reason to fetch again until /api/state itself moves on.
let fetching: string | null = null, fetchedFor: { routine: string; head: number | null } | null = null;
// Each routine's run feed (src/lib/runwindow.ts): its refresh, the refill after it and Load older queue up there, never
// overlapping, and each commits whole. What it holds is copied into state.reviews for the routine shown.
const windows = new RunWindows((id) => (before, limit) => store.reviews(id, { before, limit }), (id, win) => {
  if (currentRoutine() !== id) return;
  state.reviews.data = win.data;
  Object.assign(state.reviews.older, { routine: id, runs: win.older, more: win.olderMore });
});
const windowFor = (id: string) => windows.get(id);
export function loadReviews(force = false): void {
  const R = state.reviews, id = currentRoutine(), d = R.data;
  if (!id || fetching === id || (R.failed && !force)) return;
  const head = routines().find((r) => r.id === id)?.version ?? null;
  if (!reviewsStale(routines(), id, d && { routine: d.routine.routine, version: d.routine.version })) return;
  if (d && d.routine.routine === id && fetchedFor && fetchedFor.routine === id && fetchedFor.head === head) return;
  // Shown data that isn't this routine's (another routine was shown, or the data was reset): a fresh window.
  if (!d || d.routine.routine !== id) windows.reset(id);
  fetching = id; R.loading = true; R.failed = "";
  // Done only once the whole refresh succeeded, its refill included: a failure leaves the routine stale, so Try
  // again (or the next live update) fetches it again.
  windowFor(id).refresh().then(() => {
    fetchedFor = { routine: id, head };
  }, (e) => {
    if (currentRoutine() === id) R.failed = e instanceof ApiError && e.status ? "The server answered " + e.status + "." : "Check your connection.";
  }).finally(() => {
    if (fetching === id) fetching = null;
    R.loading = false;
    redraw();
  });
}

/* ---------- marks ---------- */
const svg = (body: string) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
const GLYPH: Record<Glyph, string> = {
  you: "", // the hot dot
  held: '<path d="M9 6.5v11M15 6.5v11"/>',
  changes: '<path d="M7 7l10 10M17 7 7 17"/>',
  waiting: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  required: '<circle cx="12" cy="12" r="7"/>',
  approved: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  draft: '<circle cx="12" cy="12" r="7" stroke-dasharray="3.2 3"/>',
  bot: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  commented: '<path d="M4.5 5.5h15v10h-8l-5 3.5v-3.5h-2z"/>',
  checked: '<circle cx="12" cy="12" r="2.5"/>',
  skipped: '<path d="M4.5 12H15M11 7.5l4.5 4.5-4.5 4.5M19.5 6v12"/>',
};
function mark(g: Glyph, title: string): string {
  if (g === "you") return '<span class="pm pd-high" title="' + esc(title) + '"></span>';
  return '<span class="pm rvg ' + g + '" title="' + esc(title) + '">' + svg(GLYPH[g]) + "</span>";
}
// A run's action as a small chip; needs-you takes the one hot hue, and nothing else is louder than a tint.
const CHIP: Partial<Record<Glyph, string>> = { approved: "rv-ok", changes: "rv-chg", you: "rv-you", held: "rv-held" };
const chip = (g: Glyph, text: string) => '<span class="badge rv ' + (CHIP[g] || "rv-quiet") + '">' + esc(text) + "</span>";
const prStatusLabel = (pr: ReviewPr) => (needsYou(pr) ? "Needs you · " : "") + STATUS[statusOf(pr)].label;

/* ---------- the routine card (S2's Now bar), above the toggle ---------- */
export function reviewsCard(): string {
  const id = currentRoutine(), d = shown(), tz = scheduleZone(), now = Date.now();
  if (!id) return "";
  const all = routines();
  // Another routine (a dry-run one, say) is a link away.
  const others = all.length > 1 ? '<span class="rcswitch">' + all.map((r) => r.id === id
    ? '<span class="rcname" aria-current="true">' + esc(r.id) + "</span>"
    : '<a class="rcname" href="#reviews.' + esc(encodeURIComponent(r.id)) + '">' + esc(r.id) + "</a>").join("") + "</span>"
    : '<span class="rcname">' + esc(id) + "</span>";
  if (!d) return '<section class="mcard rcard" aria-label="Review routine"><div class="rchead"><span class="tick unknown"><span class="dot" aria-hidden="true"></span><span>' +
    (state.reviews.failed ? "Couldn't load the routine" : "Loading the routine…") + "</span></span>" + others + "</div></section>";
  const s = routineStatus(d.routine, d.runs, tz, now), last = d.runs.find((r) => r.result !== "running");
  const needs = groupPrs(d.prs).needs, need = needs.length, act = cardAction(needs, state.loaded ? state.items : [], id);
  let h = '<section class="mcard rcard" aria-label="Review routine ' + esc(id) + '">' +
    '<div class="rchead"><span class="tick ' + s.kind + '"><span class="dot" aria-hidden="true"></span><span class="vh">Routine status: </span><span>' + esc(s.text) + "</span></span>" + others + "</div>";
  const headline = last && last.data && last.data.headline;
  if (headline) h += '<p class="rcline">' + inlineMd(headline) + "</p>";
  h += runRow(id, d.routine, d.runs, tz, now);
  // One PR needing you: its one action here. More: the count takes you to the Needs you group.
  if (act) {
    const count = need + " need" + (need === 1 ? "s" : "") + " you";
    h += '<div class="rcacts">' + (act.kind === "group"
      ? '<button type="button" class="hbadge rvneed" data-rv-needs><span class="need">' + count + "</span></button>"
      : '<span class="hbadge"><span class="need">' + count + '</span></span><a class="btn primary rcgo" href="' + esc(act.href) + '">' + esc(act.text) + "</a>") + "</div>";
  }
  return h + "</section>";
}

// The Run button: asks the routine's runner for one run now (docs/reviews.md "Run requests"), then says how that went. Deciders and
// admins only, like the server; a viewer sees no row.
let asking = false;
function runRow(id: string, head: ReviewRoutineHead, runs: ReviewRun[], tz: string, now: number): string {
  if (!canAct(myRole())) return "";
  const a = runAsk(head, runs, tz, now), busy = a.busy || asking;
  const note = a.note ? '<span class="rcnote' + (a.warn ? " warn" : "") + '" id="rcrun-note">' + esc(a.note) +
    (a.run ? ' · <a href="' + esc(runHref(a.run, id)) + '">View run</a>' : "") + "</span>" : "";
  return '<div class="rcrun"><button type="button" class="btn rcrunbtn" data-rv-run="' + esc(id) + '"' + (busy ? " disabled" : "") +
    (note ? ' aria-describedby="rcrun-note"' : "") + ">" + esc(asking ? "Asking…" : a.label) + "</button>" + note + "</div>";
}
async function askRun(id: string): Promise<void> {
  const d = shown();
  if (asking || !d || d.routine.routine !== id) return;
  if (!state.loaded) { toast("Still connecting. Try again in a moment."); return; }
  if (state.offline) { toast("Offline. Ask for a run once you're back online."); return; }
  if (!confirm("Start a " + id + " run now? It reviews every PR it tracks, which can take a while and costs model tokens.")) return;
  asking = true; redraw();
  try {
    const res = await store.askRun(id);
    if (shown() === d) d.routine.run_request = res.request;
    toast("Run requested");
  } catch (e) {
    const st = e instanceof ApiError ? e.status : 0;
    if (st === 409 && e instanceof ApiError) {
      const cur = (e.current as unknown as ReviewRunRequestResponse | null)?.request;
      if (cur !== undefined && shown() === d) d.routine.run_request = cur;
      toast(e.message || "A run is already requested or going.");
    } else {
      toast(st === 401 ? "Signed out — reload to sign in again." : st === 403 ? "You don't have permission to start a run." : "Couldn't ask for the run. Try again.");
    }
  } finally {
    // The redraw replaces the button: keep focus on it (disabled now, it still takes focus back from body).
    asking = false; redraw();
    document.querySelector<HTMLElement>("[data-rv-run]")?.focus();
  }
}

/* ---------- Runs | PRs ---------- */
export function reviewsSeg(): string {
  const d = shown(); if (!d) return "";
  const today = runsToday(d.runs, scheduleZone()), prs = d.prs.filter((r) => !r.gone_at).length;
  const btn = (v: "runs" | "prs", label: string, n: string) => '<button type="button" role="radio" class="segbtn" data-rvview="' + v + '" aria-checked="' + (state.reviews.view === v) + '">' +
    label + ' <span class="count">' + n + "</span></button>";
  return '<div class="seg" role="radiogroup" aria-label="Show">' + btn("runs", "Runs", today + " today") + btn("prs", "PRs", String(prs)) + "</div>";
}
export function wireReviewsSeg(after: () => void): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const run = t.closest<HTMLElement>("[data-rv-run]");
    if (run) { void askRun(run.dataset.rvRun || ""); return; }
    // The card's "N need you": the PRs view, at its Needs you group.
    if (t.closest("[data-rv-needs]")) {
      setReviewsView("prs"); after();
      const g = document.getElementById("rv-needs");
      g?.focus({ preventScroll: true }); g?.scrollIntoView({ block: "start" });
      return;
    }
    const b = t.closest<HTMLElement>("[data-rvview]");
    if (!b) return;
    setReviewsView(b.dataset.rvview === "runs" ? "runs" : "prs");
    after();
    document.querySelector<HTMLElement>('#reviews-seg [data-rvview="' + state.reviews.view + '"]')?.focus();
  });
}

/* ---------- the list ---------- */
// The loaded runs: the newest page, then the older pages Load older fetched for this routine.
function allRuns(): ReviewRun[] {
  const d = shown(), o = state.reviews.older;
  return d ? mergeRuns(d.runs, o.routine === d.routine.routine ? o.runs : []) : [];
}
// Under the feed while the routine keeps older runs (GET /api/reviews/:routine `more`, then each older page's).
function olderButton(): string {
  const d = shown(), o = state.reviews.older;
  if (!d) return "";
  const more = o.routine === d.routine.routine && o.more !== null ? o.more : d.more;
  return more ? '<div class="hmore"><button type="button" class="btn" data-rv-older' + (o.loading ? " disabled" : "") + ">" + (o.loading ? "Loading…" : "Load older runs") + "</button></div>" : "";
}
export async function loadOlderRuns(): Promise<void> {
  const d = shown(), o = state.reviews.older;
  if (!d || o.loading) return;
  const id = d.routine.routine;
  if (o.routine !== id) Object.assign(o, { routine: id, runs: [], more: null });
  o.loading = true; redraw();
  try {
    await windowFor(id).loadOlder();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast("Couldn't load older runs. Try again.");
  } finally {
    o.loading = false; redraw();
  }
}
export function reviewsListHtml(): string {
  const R = state.reviews, id = currentRoutine(), d = shown();
  if (!id) {
    return '<div class="empty"><strong>No review routine has reported yet.</strong><span class="small">When a review routine stores its first run, ' +
      "what it did and where every PR stands show here.</span></div>";
  }
  if (!d) {
    if (R.failed) return '<div class="empty"><strong>Reviews couldn\'t load.</strong><span class="small">' + esc(R.failed) + '</span><button type="button" class="btn" data-rv-retry>Try again</button></div>';
    return '<div class="skel" aria-busy="true"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>';
  }
  return R.view === "runs" ? runsHtml(allRuns(), d.routine.next_run_at, id) + olderButton() : prsHtml(d.prs, d.runs, id);
}

// "14:15–14:43": the times of day, under a header (or kicker) that names the day.
function span(f: FeedRun, tz: string): string {
  if (f.started == null) return f.stamp;
  return zoneClock(f.started, tz) + (f.finished != null ? "–" + zoneClock(f.finished, tz) : "");
}
const mins = (f: FeedRun) => (f.started != null && f.finished != null ? Math.max(0, Math.round((f.finished - f.started) / 60000)) + "m" : "");
const ROWS_PER_RUN = 6;

function feedRow(r: FeedRow, routine: string): string {
  return '<li><a class="rvact" href="' + prHref(r.n, routine) + '">' + chip(r.glyph, r.verb) + '<span class="rvn">#' + r.n + '</span><span class="rvwhat">' + esc(r.what) + "</span></a></li>";
}

function runsHtml(runs: ReviewRun[], next: string | null, routine: string): string {
  const tz = scheduleZone(), now = Date.now(), feed = runFeed(runs);
  let h = "";
  const nextMs = toMs(next);
  if (!isNaN(nextMs) && nextMs > now - 20 * 60000 && !feed.some((f) => f.running)) {
    h += '<p class="rvnext"><span class="rvring" aria-hidden="true"></span>Next run <b>' + esc(slotTime(nextMs, tz, now)) + "</b></p>";
  }
  if (!feed.length) return h + '<div class="empty"><strong>No runs yet.</strong><span class="small">Each run shows here with what it posted, newest first.</span></div>';
  h += dayRuns(feed, (f) => (f.started == null ? "" : dayKey(f.started, tz))).map((day) =>
    '<h3 class="ghead day">' + esc(dayLabel(day.day, tz, now)) + "</h3>" + day.rows.map((f) => {
      const g: Glyph = f.running ? "waiting" : f.ok ? "checked" : "held";
      const bits = [mins(f) && '<span class="rvdur">' + mins(f) + "</span>", f.ok || f.running ? "" : chip("held", f.result), f.running ? chip("commented", "Running") : "", f.dry ? chip("commented", "Dry run") : ""].filter(Boolean).join(" ");
      const line = f.error && !f.ok ? f.error : f.headline || (f.ok ? "Nothing posted" : "No report");
      let r = '<div class="rowwrap rvrun"><a class="row irow" href="' + runHref(f.stamp, routine) + '">' + mark(g, "Run: " + f.result) +
        '<span class="rbody"><span class="rtitle"><span class="rvspan">' + esc(span(f, tz)) + "</span> " + bits + '<span class="vh">, ' + esc(f.result) + "</span></span>" +
        '<span class="rmeta">' + esc(line) + "</span></span>" +
        '<span class="chev" aria-hidden="true">&rsaquo;</span></a></div>';
      if (f.rows.length) {
        const more = f.rows.length - ROWS_PER_RUN;
        r += '<ul class="rvacts" aria-label="What the ' + esc(span(f, tz)) + ' run did">' + f.rows.slice(0, more > 0 ? ROWS_PER_RUN - 1 : ROWS_PER_RUN).map((x) => feedRow(x, routine)).join("") +
          (more > 0 ? '<li><a class="rvact rvmore" href="' + runHref(f.stamp, routine) + '">' + (more + 1) + " more in this run</a></li>" : "") + "</ul>";
      }
      return r;
    }).join("")).join("");
  return h;
}

// One PR row: the mark, "#812 Title" over the routine's last move on it, the time, a chevron.
function prRow(row: ReviewPrRow, ctx: ReturnType<typeof lineCtx>, tz: string, now: number, routine: string): string {
  const pr = row.data, l = lastLine(row, ctx), when = shortWhen(l.at, tz, now);
  const who = !isMine(pr) && !isBot(pr) && pr.author ? '<span class="mo">' + esc(pr.author) + "</span>" : "";
  // A gone PR (only a pinned one is listed) says so in place of the routine's last move.
  const meta = row.gone_at ? '<span class="mt">Dropped out of the newest report</span> ' + relSpan(row.gone_at, true)
    : '<span class="mt">' + esc(l.text) + "</span>" + (l.opened && when ? " <span>opened " + esc(when) + "</span>" : "") + (who ? " " + who : "");
  return '<div class="rowwrap"><a class="row irow" href="' + prHref(row.number, routine) + '">' + mark(glyphOf(pr), prStatusLabel(pr)) +
    '<span class="rbody"><span class="rtitle"><span class="rvn">#' + row.number + "</span> " + esc(pr.title) + '<span class="vh">, ' + esc(prStatusLabel(pr)) + "</span></span> " +
    '<span class="rmeta">' + meta + "</span></span>" +
    (when && !l.opened ? ' <span class="rel clk" title="' + esc(zoneStamp(l.at, tz)) + '">' + esc(when) + "</span>" : "") +
    '<span class="chev" aria-hidden="true">&rsaquo;</span></a></div>';
}

function prsHtml(rows: ReviewPrRow[], runs: ReviewRun[], routine: string): string {
  // The viewer's pinned PRs on top (src/lib/pins.ts), gone ones too: those the list no longer holds are fetched on their own.
  const pin = pinPrs(rows, routine, state.pins), fetched = pin.missing.map((n) => loadPr(routine, n)).flatMap((got) => (typeof got === "object" ? [got.pr] : []));
  const pinned = splitPinned(pin.pinned.concat(fetched), (r) => pinKey("pr", routine + "/" + r.number), state.pins).pinned;
  const g = groupPrs(pin.rest), ctx = lineCtx(runs), tz = scheduleZone(), now = Date.now();
  // Every PR that needs you pinned: the card's "N need you" (data-rv-needs) goes to them, in Pinned.
  const needsPinned = !g.needs.length && pinned.some((r) => !r.gone_at && needsYou(r.data));
  const top = pinned.length ? pinnedHead(pinned.length, needsPinned ? "rv-needs" : undefined) + pinned.map((r) => prRow(r, ctx, tz, now, routine)).join("") : "";
  if (!GROUPS.some((x) => g[x.id].length)) return top + (top ? "" : '<div class="empty"><strong>No open PRs.</strong><span class="small">The routine\'s newest report lists none.</span></div>');
  return top + GROUPS.map((grp) => {
    const list = g[grp.id];
    if (!list.length && !grp.empty) return "";
    const head = '<h3 class="ghead' + (grp.id === "needs" ? ' high" id="rv-needs" tabindex="-1' : "") + '">' + esc(grp.label) + ' <span class="gn">' + list.length + "</span>" +
      (grp.fold ? '<span class="caret" aria-hidden="true">&rsaquo;</span>' : "") + "</h3>";
    const body = list.length ? list.map((r) => prRow(r, ctx, tz, now, routine)).join("") : '<p class="hnote rvempty">' + esc(grp.empty || "") + "</p>";
    if (!grp.fold) return head + body;
    return '<details class="snzgroup rvfold" data-rvfold="' + grp.id + '"' + (state.reviews.open.has(grp.id) ? " open" : "") + "><summary>" + head + "</summary>" + body + "</details>";
  }).join("");
}
// Mine and Bots stay as the viewer left them across live re-renders.
export function wireReviewFolds(list: HTMLElement): void {
  list.querySelectorAll<HTMLDetailsElement>("[data-rvfold]").forEach((d) => d.addEventListener("toggle", () => {
    const id = d.dataset.rvfold || "";
    if (d.open) state.reviews.open.add(id); else state.reviews.open.delete(id);
  }));
}

// From 700px, the pane beside the list with nothing selected.
export function reviewsPlaceholder(keys: string): string {
  return '<div class="phbox"><p class="phtitle">Select a run or a PR</p><p class="phtext">It opens here, beside the list.</p>' + keys + "</div>";
}

/* ---------- a run's page (#run.<stamp>) ---------- */
function findRun(stamp: string): ReviewRun | "loading" | "missing" | "failed" | null {
  const d = shown();
  if (!d) return null;
  const inPage = allRuns().find((r) => r.stamp === stamp);
  if (inPage) return inPage;
  // Older than the page loaded: fetched by its stamp.
  const id = d.routine.routine, key = id + "/" + stamp, got = state.reviews.runs.get(key);
  if (got) return got;
  state.reviews.runs.set(key, "loading");
  store.reviewRun(id, stamp).then((r) => { state.reviews.runs.set(key, r); },
    (e) => { state.reviews.runs.set(key, e instanceof ApiError && e.status === 404 ? "missing" : "failed"); }).finally(() => redraw());
  return "loading";
}

// What the run page and the title show while it loads, or where it can't.
function pending(box: HTMLElement, sig: string, html: string): void {
  if (state.shownSig !== sig) { state.shownSig = sig; box.innerHTML = html; }
}
const gone = (what: string) => '<div class="panel empty"><strong>' + what + '</strong><a class="btn" href="#reviews">Back to Reviews</a></div>';

export function reviewTitle(): string | null {
  const r = state.route, d = shown();
  if (!d) return null;
  if (r.view === "pr") { const row = d.prs.find((p) => p.number === r.n); return row ? "#" + row.number + " " + (row.data.title || "") : null; }
  if (r.view === "run") {
    const run = d.runs.find((x) => x.stamp === r.stamp) || state.reviews.runs.get(d.routine.routine + "/" + r.stamp);
    if (!run || typeof run === "string") return null;
    const f = runFeed([run])[0];
    const tz = scheduleZone();
    return "Run " + (f.started != null ? dayLabel(dayKey(f.started, tz), tz) + " " : "") + span(f, tz);
  }
  return null;
}

export function renderRunPage(stamp: string, box: HTMLElement): void {
  if (!state.loaded || !currentRoutine()) { if (state.loaded) pending(box, "norutine", gone("No review routine has reported yet.")); else pending(box, "loading", skeleton(3)); return; }
  loadReviews();
  if (state.reviews.failed && !shown()) { pending(box, "failed", gone("Reviews couldn't load.")); return; }
  const run = findRun(stamp);
  if (!run || run === "loading") { pending(box, "loading", skeleton(3)); return; }
  if (run === "missing" || run === "failed") { pending(box, run, gone(run === "missing" ? "No run at " + esc(stamp) + "." : "That run couldn't load.")); return; }
  const tz = scheduleZone(), now = Date.now(), f = runFeed([run])[0], d = run.data;
  const sig = JSON.stringify([run, dayKey(now, tz)]);
  if (sig === state.shownSig) return;
  state.shownSig = sig;
  const prs = new Map((shown()?.prs || []).map((p) => [p.number, p]));
  let h = '<article class="show rvpage">';
  h += '<div class="ohead"><span class="okick"><span>Run</span> &middot; <span>' + esc(f.started != null ? dayLabel(dayKey(f.started, tz), tz, now) : "") + "</span></span>" +
    '<span class="oupd">' + esc(run.routine) + "</span></div>";
  h += '<h2 id="page-title" tabindex="-1">' + esc(span(f, tz)) + "</h2>";
  const facts = [chip(f.ok ? "approved" : f.running ? "commented" : "held", f.result), mins(f), f.exit != null ? "exit " + f.exit : "", f.dry ? "dry run" : "", d && d.model ? esc(d.model) : ""].filter(Boolean);
  h += '<p class="rvfacts">' + facts.join('<span class="sep" aria-hidden="true"> · </span>') + "</p>";
  if (f.headline) h += '<p class="headline">' + inlineMd(f.headline) + "</p>";
  if (f.error) h += '<div class="panel rverr"><p class="slabel">What went wrong</p><div class="md">' + md(f.error) + "</div></div>";
  if (f.rows.length) {
    h += '<section class="bk"><h3 class="olbl">What it did <span class="gn">' + f.rows.length + '</span></h3><div class="rows">' + f.rows.map((x) => {
      const p = prs.get(x.n), review = x.url ? '<span class="rowside"><a class="iconlink" href="' + esc(x.url) + '" target="_blank" rel="noopener" title="The review on GitHub" aria-label="#' + x.n + ': the review on GitHub">' +
        svg('<path d="M14 5h5v5M19 5l-8 8M10 6H6v12h12v-4"/>') + "</a></span>" : "";
      return '<div class="rowwrap"><a class="row irow" href="' + prHref(x.n, run.routine) + '">' + mark(x.glyph, x.verb) +
        '<span class="rbody"><span class="rtitle"><span class="rvn">#' + x.n + "</span> " + esc(p ? p.data.title : x.what) + "</span> " +
        '<span class="rmeta"><span class="mt">' + esc(x.verb) + "</span> " + (p ? esc(x.what) : "") + "</span></span>" +
        '<span class="chev" aria-hidden="true">&rsaquo;</span></a>' + review + "</div>";
    }).join("") + "</div></section>";
  } else if (f.ok) h += '<p class="calm">Nothing posted this run</p>';
  const skipped = d && d.skipped && typeof d.skipped === "object" ? d.skipped : {};
  const same = Array.isArray(skipped.same_patch) ? skipped.same_patch.length : 0;
  if (same || f.stale) {
    h += '<section class="bk"><h3 class="olbl">Skipped</h3><p class="rvskip">' + [same ? same + " same-patch rebase" + (same === 1 ? "" : "s") : "", f.stale ? f.stale + " stale PR" + (f.stale === 1 ? "" : "s") + " (no activity in 60 days)" : ""].filter(Boolean).join(" · ") + "</p></section>";
  }
  for (const [label, list] of [["Unverified", f.unverified], ["Notes", f.notes]] as const) {
    if (list.length) h += '<section class="bk"><h3 class="olbl">' + label + '</h3><ul class="rvlist md">' + list.map((x) => "<li>" + inlineMd(x) + "</li>").join("") + "</ul></section>";
  }
  if (f.log) h += '<section class="bk"><h3 class="olbl">Log</h3><p class="rvlog"><code>' + esc(f.log) + "</code></p></section>";
  box.innerHTML = h + "</article>";
}

/* ---------- a PR's page (#pr.<n>) ---------- */
// GET /api/reviews/:routine/prs/:n: the row (also for a PR gone from the list) and its events, refetched once the
// routine's head moves on.
function prKey(routine: string, n: number): string { return routine + "/" + n; }
// The page the PR pane last built, without its timeline (renderPrPage).
let shownPage = "";
// A PR page arrived at: a fetch that failed before is tried again, never left standing in for the PR.
export function forgetFailedPrs(): void {
  for (const [k, v] of state.reviews.prs) if (v.state === "failed") state.reviews.prs.delete(k);
}
function loadPr(routine: string, n: number): ReviewPrResponse | "loading" | "missing" | "failed" {
  const key = prKey(routine, n), head = routines().find((r) => r.id === routine)?.version ?? null, got = state.reviews.prs.get(key);
  const v = prFetchView(got, head);
  if (!v.fetch) return v.show;
  // A refetch keeps showing what it had meanwhile (src/lib/reviews.ts prFetchView).
  state.reviews.prs.set(key, { version: head, state: "loading", data: got?.data ?? null });
  store.reviewPr(routine, n).then((r) => { state.reviews.prs.set(key, { version: head, state: "ok", data: r }); },
    (e) => { state.reviews.prs.set(key, { version: head, state: e instanceof ApiError && e.status === 404 ? "missing" : "failed", data: null }); })
    .finally(() => redraw());
  return v.show;
}

// The item page's way to the PR it asks about (src/views/item.ts), for a routine that has reported.
export function reviewChip(item: ItemRow): string {
  const p = reviewPrOf(item, routines().map((r) => r.id));
  if (!p) return "";
  // A shared call: a chip for each PR it covers.
  return [p.n, ...alsoPrsOf(item)].map((n) => '<a class="chip rvchip" href="' + prHref(n, p.routine) + '">#' + n + " in Reviews</a>").join("");
}

const TL_FILTERS: [TimelineFilter, string][] = [["all", "All"], ["routine", "Routine"], ["author", "Author"], ["you", "You"]];
function timeline(row: ReviewPrRow, got: ReviewPrResponse | "loading" | "missing" | "failed", asks: ItemRow[], tz: string, now: number): string {
  const f = state.reviews.tl;
  const seg = '<div class="seg rvtlseg" role="radiogroup" aria-label="Show in the timeline">' + TL_FILTERS.map(([id, label]) =>
    '<button type="button" role="radio" class="segbtn" data-rvtl="' + id + '" aria-checked="' + (f === id) + '">' + label + "</button>").join("") + "</div>";
  let body: string;
  if (got === "loading") body = '<p class="hnote rvtlnote" role="status">Loading the timeline…</p>';
  else if (got === "failed" || got === "missing") body = '<p class="hnote rvtlnote">The timeline couldn\'t load. <button type="button" class="btn" data-rvpr-retry>Try again</button></p>';
  else {
    const all = prTimeline(row, got.events, asks, myEmail()), list = filterTimeline(all, f);
    body = !list.length ? '<p class="hnote rvtlnote">' + (all.length ? "Nothing from " + (f === "you" ? "you" : "the " + f) + " yet." : "Nothing yet.") + "</p>"
      : dayRuns(list, (e) => (e.at == null ? "" : dayKey(e.at, tz))).map((day) => '<h4 class="ghead day">' + esc(dayLabel(day.day, tz, now)) + '</h4><ol class="rvtlist">' +
        day.rows.map((e) => '<li class="rvte ' + e.who + '"><span class="rvtt">' + esc(e.at == null ? "" : zoneClock(e.at, tz)) + "</span>" +
          '<span class="rvtw"><b>' + (e.href ? '<a href="' + esc(e.href) + '">' + esc(e.verb) + "</a>" : esc(e.verb)) + "</b>" + (e.text ? " " + inlineMd(e.text) : "") +
          (e.url ? ' <a class="rvtlink" href="' + esc(e.url) + '" target="_blank" rel="noopener">review &#8599;</a>' : "") + "</span></li>").join("") + "</ol>").join("");
  }
  return '<section class="bk rvtl" aria-labelledby="rv-tl"><div class="rvtlhead"><h3 class="olbl" id="rv-tl">Timeline</h3>' + seg + "</div>" + body + "</section>";
}
export function wireReviewPane(): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement, b = t.closest<HTMLElement>("[data-rvtl]");
    if (b) {
      state.reviews.tl = (TL_FILTERS.find(([id]) => id === b.dataset.rvtl)?.[0]) ?? "all";
      redraw();
      document.querySelector<HTMLElement>('[data-rvtl="' + state.reviews.tl + '"]')?.focus();
    }
    if (t.closest("[data-rvpr-retry]") && state.route.view === "pr") {
      const id = currentRoutine(); if (id) state.reviews.prs.delete(prKey(state.route.routine ?? id, state.route.n));
      redraw();
    }
  });
}

export function renderPrPage(n: number, box: HTMLElement): void {
  if (!state.loaded || !currentRoutine()) { if (state.loaded) pending(box, "norutine", gone("No review routine has reported yet.")); else pending(box, "loading", skeleton(3)); return; }
  loadReviews();
  const d = shown(), id = currentRoutine()!;
  if (!d && state.reviews.failed) { pending(box, "failed", gone("Reviews couldn't load.")); return; }
  const got = loadPr(id, n);
  // The list's row when it's there (a gone PR from the fetch), so the page shows at once with the list.
  const row = d?.prs.find((p) => p.number === n) ?? (typeof got === "object" ? got.pr : null);
  if (!row) {
    // A failed fetch isn't a PR the routine doesn't track: say so, with Try again (data-rvpr-retry forgets it).
    if (got === "failed") pending(box, "prfailed", '<div class="panel empty"><strong>#' + n + " couldn't load.</strong>" +
      '<span class="small">The server didn\'t answer for it. Check your connection.</span><button type="button" class="btn" data-rvpr-retry>Try again</button></div>');
    else if (!d || got === "loading") pending(box, "loading", skeleton(3));
    else pending(box, "missing", gone("#" + n + " isn't one of " + esc(id) + "'s PRs."));
    return;
  }
  const tz = scheduleZone(), now = Date.now(), asks = asksFor(state.items, id, n);
  const pinned = pinKey("pr", id + "/" + n);
  const pageSig = JSON.stringify([n, row, asks, d?.routine.next_run_at, dayKey(now, tz), pinSig(pinned)]);
  const sig = JSON.stringify([pageSig, typeof got === "object" ? got.events : got, state.reviews.tl]);
  if (sig === state.shownSig) return;
  // Only the timeline changed (it loaded, or its filter moved): just it is replaced, so the heading (or anything else
  // focused on the page) keeps focus.
  const tl = box.querySelector(".rvtl");
  if (tl && shownPage === pageSig) {
    state.shownSig = sig;
    const filter = (document.activeElement as HTMLElement | null)?.dataset?.rvtl;
    tl.outerHTML = timeline(row, got, asks, tz, now);
    if (filter) box.querySelector<HTMLElement>('[data-rvtl="' + filter + '"]')?.focus();
    return;
  }
  state.shownSig = sig; shownPage = pageSig;
  const pr = row.data, url = httpsUrl(pr.url), hd = rvHead(row, asks, d ? d.routine.next_run_at : null, tz, now);
  // The sticky header: the status, what clears it, the one action (src/lib/reviews.ts rvHead).
  let h = '<article class="show rvpage rvpr"><header class="rvhead">';
  h += '<div class="ohead"><span class="okick">' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">#' + n + " &#8599;</a>" : "#" + n) +
    (pr.author ? " <span>by " + esc(pr.author) + "</span>" : "") + (pr.base ? " <span>into " + esc(pr.base) + "</span>" : "") + "</span>" +
    (row.updated_at ? '<span class="oupd">as of ' + relSpan(row.updated_at) + "</span>" : "") + pinButton(pinned, "Reviews") + "</div>";
  h += '<h2 id="page-title" tabindex="-1">' + esc(pr.title || "#" + n) + "</h2>";
  // One row, the status chip and the action (a phone keeps just this row in view, the chip ellipsized), then what
  // clears it, with the chip's whole text on a phone.
  const g: Glyph = hd.chip === "decided" ? "approved" : hd.chip === "you" || hd.chip === "held" || hd.chip === "approved" || hd.chip === "changes" ? hd.chip : "commented";
  h += '<div class="rvhline">' + chip(g, hd.label).replace('<span class="badge', '<span title="' + esc(hd.label) + '" class="badge') +
    (hd.action ? '<a class="btn primary rvgo" href="' + esc(hd.action.href) + '"' + (hd.action.external ? ' target="_blank" rel="noopener"' : "") + ">" + esc(hd.action.text) + "</a>" : "") + "</div>";
  h += '<p class="rvclears"><span class="rvfull">' + esc(hd.label) + ". </span>" + esc(hd.clears) + "</p>";
  h += "</header>";
  if (row.gone_at) h += '<p class="hnote rvgone">Dropped out of the newest report ' + relSpan(row.gone_at) + ": merged, closed or gone stale.</p>";
  if (pr.status_note) h += '<div class="md rvnote">' + md(pr.status_note) + "</div>";
  // The action's other half: GitHub stays a link when the header sends you to the Inbox.
  if (hd.action && !hd.action.external && url) h += '<p class="rvalso"><a href="' + esc(url) + '" target="_blank" rel="noopener">Review on GitHub &#8599;</a></p>';
  const ny = pr.needs_you;
  if (ny && typeof ny === "object") {
    h += '<section class="panel rvcall" aria-labelledby="rv-call"><p class="slabel" id="rv-call">The call</p><p class="rvask">' + inlineMd(ny.ask || "") + "</p>" +
      (Array.isArray(ny.facts) && ny.facts.length ? '<ul class="rvlist md">' + ny.facts.map((x) => "<li>" + inlineMd(x) + "</li>").join("") + "</ul>" : "") +
      (Array.isArray(ny.options) && ny.options.length ? '<p class="slabel">Options</p><ol class="rvlist md">' + ny.options.map((x) => "<li>" + inlineMd(x) + "</li>").join("") + "</ol>" : "") + "</section>";
  }
  const kv: [string, string][] = [];
  if (pr.impact) kv.push(["Impact", '<div class="md">' + md(pr.impact) + "</div>"]);
  if (Array.isArray(pr.tradeoffs) && pr.tradeoffs.length) kv.push(["Tradeoffs", '<ol class="rvlist">' + pr.tradeoffs.map((x) => "<li>" + inlineMd(x) + "</li>").join("") + "</ol>"]);
  const risks = Array.isArray(pr.risks) ? pr.risks : [];
  if (pr.risk || risks.length) kv.push(["Risk", (pr.risk ? "<b>" + esc(pr.risk[0].toUpperCase() + pr.risk.slice(1)) + ".</b> " : "") + risks.map((x) => inlineMd(x)).join(" ")]);
  const th = pr.threads && typeof pr.threads === "object" ? pr.threads : null;
  if (th) {
    const items = Array.isArray(th.items) ? th.items : [];
    kv.push(["Threads", esc(th.open ?? 0) + " open" + (items.length ? '<ul class="rvlist">' + items.map((t) => {
      const u = httpsUrl(t.url), where = esc(t.where || "thread");
      return "<li>" + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + where + "</a>" : where) + (t.summary ? " " + inlineMd(t.summary) : "") + "</li>";
    }).join("") + "</ul>" : "")]);
  }
  if (pr.ci && typeof pr.ci === "object") {
    const u = httpsUrl(pr.ci.url), CI: Record<string, string> = { passing: "Passing", failing: "Failing", pending: "Running", none: "No CI" };
    kv.push(["CI", esc(CI[pr.ci.state] || pr.ci.state) + (u ? ' · <a href="' + esc(u) + '" target="_blank" rel="noopener">checks</a>' : "") + (pr.ci.note ? " · " + inlineMd(pr.ci.note) : "")]);
  }
  const MERGE: Record<string, string> = { clean: "Clean", blocked: "Blocked", conflicts: "Conflicts", behind: "Behind base", unknown: "Unknown" };
  if (pr.mergeable) kv.push(["Merge", esc(MERGE[pr.mergeable] || pr.mergeable)]);
  if (Array.isArray(pr.reviewers) && pr.reviewers.length) {
    kv.push(["Reviewers", '<ul class="rvwho">' + pr.reviewers.map((r) => "<li><span>" + esc(r.login) + '</span><span class="rvwst">' + esc(String(r.state).replace(/_/g, " ")) + "</span></li>").join("") + "</ul>"]);
  }
  if (kv.length) h += '<dl class="okv rvkv">' + kv.map((r) => "<div><dt>" + r[0] + "</dt><dd>" + r[1] + "</dd></div>").join("") + "</dl>";
  const links = [...(Array.isArray(pr.linear) ? pr.linear.map((l) => ({ label: l.id, url: l.url })) : []), ...(Array.isArray(pr.links) ? pr.links : [])]
    .map((l) => ({ label: l.label, u: httpsUrl(l.url) })).filter((l) => l.u);
  if (links.length) h += '<div class="links">' + links.map((l) => '<a href="' + esc(l.u) + '" target="_blank" rel="noopener">' + esc(l.label || l.u) + "</a>").join("") + "</div>";
  h += timeline(row, got, asks, tz, now);
  // A live re-render keeps the heading focused when it was (the route's focus went there).
  const titled = document.activeElement?.id === "page-title" && box.contains(document.activeElement);
  box.innerHTML = h + "</article>";
  if (titled) box.querySelector<HTMLElement>("#page-title")?.focus({ preventScroll: true });
}
