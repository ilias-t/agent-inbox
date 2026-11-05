import { describe, expect, it } from "vitest";
import type { ReviewPr, ReviewPrRow, ReviewRunRequest } from "../../shared/types.ts";
import {
  ACTION, clearsText, glyphOf, groupPrs, lastLine, lineCtx, mergeRuns, parseReviewHash, pickRoutine, prHref, reviewsStale, routeHref, routineStatus, runAsk, runFeed, runHref, runsToday, shortWhen, statusOf,
} from "../../src/lib/reviews.ts";
import { reportPayloadProblems } from "../../shared/reviews.ts";
import { UI_ROUTINE, stampOf, uiPayloads, uiRoutine, uiRuns } from "../fixtures/review-ui.ts";

// Thu 8 Oct 2026, 15:30 in New York: the newest run started at 14:15 and finished at 14:43; the next one is at 16:15.
const NOW = Date.parse("2026-10-08T19:30:00Z"), TZ = "America/New_York", MIN = 60000;
const data = uiRoutine(NOW);
const byNumber = (n: number): ReviewPrRow => data.prs.find((r) => r.number === n)!;
const nums = (rows: ReviewPrRow[]) => rows.map((r) => r.number);
const withPr = (n: number, over: Partial<ReviewPr>): ReviewPrRow => { const r = byNumber(n); return { ...r, data: { ...r.data, ...over } }; };

describe("groupPrs", () => {
  const g = groupPrs(data.prs);

  it("puts needs-you PRs first, ones I review before mine and bots", () => {
    expect(nums(g.needs)).toEqual([812, 798]);
  });
  it("orders the other groups by status, then by the routine's latest move", () => {
    expect(nums(g.held)).toEqual([806, 805]);
    expect(nums(g.author)).toEqual([803, 801, 799]);
    expect(nums(g.approved)).toEqual([809, 797]);
    expect(nums(g.mine)).toEqual([815, 811, 814, 808]);
    expect(nums(g.bots)).toEqual([810, 790]);
  });
  it("lists every current PR exactly once and leaves out the ones gone from the newest report", () => {
    const all = Object.values(g).flatMap(nums);
    expect(all.sort()).toEqual(data.prs.filter((r) => !r.gone_at).map((r) => r.number).sort());
    expect(all).not.toContain(795);
  });
});

describe("statusOf", () => {
  it("falls back to pending for a reviewed PR with a status from another role, or an unknown one", () => {
    expect(statusOf({ ...byNumber(799).data, status: "mine_ready" })).toBe("pending");
    expect(statusOf({ ...byNumber(799).data, status: "shipped" as never })).toBe("pending");
  });
  it("falls back to review required for my PR without a mine_ status", () => {
    expect(statusOf({ ...byNumber(814).data, status: "approved" })).toBe("mine_waiting");
  });
  it("reads a bot PR as a bot whatever its status", () => {
    expect(statusOf({ ...byNumber(810).data, status: "approved" })).toBe("bot");
  });
});

describe("awaiting_ok", () => {
  const waiting = withPr(799, { status: "awaiting_ok", needs_you: null });
  it("is a known status that groups with the held ones, ahead of them", () => {
    expect(statusOf(waiting.data)).toBe("awaiting_ok");
    const g = groupPrs([...data.prs.filter((r) => r.number !== 799), waiting]);
    expect(nums(g.held)).toEqual([799, 806, 805]);
  });
  it("shows as awaiting you, with what clears it", () => {
    expect(glyphOf(waiting.data)).toBe("you");
    // Only the ask clears it: with the review bot the draft isn't on GitHub for me to post (docs/reviews.md).
    expect(clearsText(waiting.data)).toBe("Clears when you decide its ask in the Inbox.");
  });
});

describe("drafted action", () => {
  it("reads as awaiting you, not quiet", () => {
    expect(ACTION.drafted).toMatchObject({ long: "Drafted, awaiting your OK", glyph: "you" });
    expect(ACTION.drafted.quiet).toBeUndefined();
  });
});

describe("glyphOf", () => {
  it("marks needs-you PRs, then by status", () => {
    expect(glyphOf(byNumber(812).data)).toBe("you");
    expect(glyphOf(byNumber(806).data)).toBe("held");
    expect(glyphOf(byNumber(803).data)).toBe("changes");
    expect(glyphOf(byNumber(808).data)).toBe("draft");
  });
  it("shows a bot PR the routine approved earlier as approved", () => {
    expect(glyphOf({ ...byNumber(790).data, last_action: { kind: "approved", at: null, url: null } })).toBe("approved");
    expect(glyphOf(byNumber(790).data)).toBe("bot");
  });
});

describe("lastLine", () => {
  const ctx = lineCtx(data.runs);
  it("says what this run posted, at the time of that review", () => {
    expect(lastLine(byNumber(809), ctx)).toEqual({ text: "Approved", at: NOW - 48 * MIN });
    expect(lastLine(byNumber(803), ctx).text).toBe("Requested changes");
  });
  it("says a same-patch rebase was skipped, at the newest run", () => {
    expect(lastLine(byNumber(801), ctx)).toEqual({ text: "Skipped rebase", at: NOW - 75 * MIN });
  });
  it("tells a held PR checked this run without a post from one checked and left alone", () => {
    const changed = { action: "none" as const, url: null, summary: "", changes: ["Author pushed 1 commit"] };
    expect(lastLine(withPr(806, { this_run: changed, last_action: null }), ctx).text).toBe("Checked, still held");
    expect(lastLine(withPr(799, { this_run: changed }), ctx).text).toBe("Checked, nothing posted");
  });
  it("falls back to the routine's last move from an earlier run", () => {
    expect(lastLine(byNumber(797), ctx)).toEqual({ text: "Approved", at: NOW - 1400 * MIN });
  });
  it("gives the status alone when the routine never acted", () => {
    expect(lastLine(byNumber(799), ctx)).toEqual({ text: "Pending review", at: null });
  });
  it("sums up my PR: its status, failing CI, conflicts and open threads", () => {
    expect(lastLine(byNumber(815), ctx)).toEqual({ text: "Needs your action, CI failing, 2 open threads", at: NOW - 50 * MIN });
  });
  it("says a bot PR isn't reviewed, with its merge state, dated when it opened", () => {
    const l = lastLine(byNumber(798), ctx);
    expect(l).toEqual({ text: "Not reviewed, conflicts", at: Date.parse(byNumber(798).data.created_at!), opened: true });
  });
});

describe("runFeed", () => {
  const [newest, , timedOut] = runFeed(data.runs);
  it("lists a run's actions, then needs-you PRs it didn't act on, then same-patch skips, each PR once", () => {
    expect(newest.rows.map((r) => [r.n, r.verb])).toEqual([
      [809, "Approved"], [803, "Req. changes"], [812, "Commented"], [798, "Needs you"], [801, "Skipped"],
    ]);
    expect(newest.rows.find((r) => r.n === 798)).toMatchObject({ you: true, what: "Merge, close or turn off the changelog bot?", url: null });
    expect(newest.rows[0].url).toBe("https://github.com/acme/widgets/pull/809#pullrequestreview-80901");
  });
  it("keeps the run's times, result, stale count and notes", () => {
    expect(newest).toMatchObject({ ok: true, result: "OK", started: NOW - 75 * MIN, finished: NOW - 47 * MIN, stale: 2, notes: ["CI on main was slow (35 min)"] });
  });
  it("marks a run that ended badly, with its error", () => {
    expect(timedOut).toMatchObject({ ok: false, result: "Timed out", rows: [], error: expect.stringContaining("45-minute limit") });
  });
  it("drops a review link that isn't https", () => {
    const runs = uiRuns(NOW);
    runs[0].data.actions[0].url = "javascript:alert(1)";
    expect(runFeed(runs)[0].rows[0].url).toBeNull();
  });
});

describe("runsToday", () => {
  it("counts the runs started today in the zone", () => {
    expect(runsToday(data.runs, TZ, NOW)).toBe(2);
  });
});

describe("routineStatus", () => {
  it("names the last run's span and the next run", () => {
    expect(routineStatus(data.routine, data.runs, TZ, NOW)).toEqual({ kind: "ok", text: "Last run 14:15–14:43 · next 16:15" });
  });
  it("says a run is going, from when it started", () => {
    const started = NOW - 10 * MIN, running = { ...data.runs[0], stamp: stampOf(started), started_at: new Date(started).toISOString(), finished_at: null, result: "running" as const };
    expect(routineStatus(data.routine, [running, ...data.runs], TZ, NOW)).toEqual({ kind: "pending", text: "Running since 15:20" });
  });
  it("warns when the newest finished run failed", () => {
    const runs = data.runs.slice(2);
    expect(routineStatus(data.routine, runs, TZ, NOW)).toEqual({ kind: "warn", text: "Last run timed out at Wed 18:15" });
  });
  it("warns when the next run is overdue", () => {
    const head = { ...data.routine, next_run_at: new Date(NOW - 30 * MIN).toISOString() };
    expect(routineStatus(head, data.runs, TZ, NOW)).toEqual({ kind: "warn", text: "Run overdue since 15:00" });
  });
  it("says so before the first run", () => {
    expect(routineStatus({ ...data.routine, next_run_at: null }, [], TZ, NOW)).toEqual({ kind: "unknown", text: "No runs yet" });
  });
});

describe("runAsk", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const req = (over: Partial<ReviewRunRequest>): ReviewRunRequest => ({
    id: "rq-1", status: "requested", requested_at: at(NOW - 2 * MIN), requested_by: "you@test", updated_at: at(NOW - 2 * MIN), stamp: null, message: null, ...over,
  });
  const head = (r: ReviewRunRequest | null) => ({ ...data.routine, run_request: r });
  const running = (startedMs: number) => ({ ...data.runs[0], stamp: stampOf(startedMs), started_at: at(startedMs), finished_at: null, result: "running" as const });
  const ask = (r: ReviewRunRequest | null, runs = data.runs, routine = data.routine.routine) => runAsk({ ...head(r), routine }, runs, TZ, NOW);

  it("is a plain button before the first request; a dry-run routine's says so", () => {
    expect(ask(null)).toEqual({ busy: false, label: "Run bot review", note: null, warn: false, run: null });
    expect(ask(null, data.runs, "review-bot-dry").label).toBe("Run dry review");
  });
  it("holds while the request waits on the runner, saying what it waits for", () => {
    expect(ask(req({}))).toEqual({ busy: true, label: "Requested", note: "Asked at 15:28 · waiting for the runner to pick it up", warn: false, run: null });
    expect(ask(req({ status: "starting", updated_at: at(NOW - MIN), message: "waiting for 4 GB of free memory" }))).toMatchObject({
      busy: true, label: "Starting", note: "Picked up at 15:29 · waiting for 4 GB of free memory",
    });
  });
  it("holds while a run goes, its own or any other, linking it", () => {
    const run = running(NOW - 5 * MIN);
    expect(ask(req({ status: "started", stamp: run.stamp }), [run, ...data.runs])).toEqual({ busy: true, label: "Running", note: "Your run started 15:25", warn: false, run: run.stamp });
    expect(ask(null, [run, ...data.runs])).toMatchObject({ busy: true, note: "A run is going since 15:25" });
  });
  it("lets go of a stale request or a dead run, and says so", () => {
    expect(ask(req({ requested_at: at(NOW - 40 * MIN), updated_at: at(NOW - 40 * MIN) }))).toMatchObject({ busy: false, warn: true, note: "The runner didn't start the run asked for at 14:50. Is its poller running?" });
    const dead = running(NOW - 5 * 60 * MIN);
    expect(ask(req({ status: "started", stamp: dead.stamp, updated_at: dead.started_at }), [dead, ...data.runs])).toMatchObject({ busy: false, warn: true, note: "The run from 10:30 never reported back" });
  });
  it("after its run: how it ended, linking it", () => {
    const done = data.runs[0];
    expect(ask(req({ status: "started", stamp: done.stamp }))).toEqual({ busy: false, label: "Run bot review", note: "Requested run finished at 14:43", warn: false, run: done.stamp });
    const failed = data.runs.find((r) => r.result === "timed_out")!;
    expect(ask(req({ status: "started", stamp: failed.stamp }))).toMatchObject({ warn: true, note: expect.stringMatching(/^Requested run timed out at /) });
    expect(ask(req({ status: "started", stamp: "2026-09-01T140000Z" }))).toMatchObject({ busy: false, warn: false, run: "2026-09-01T140000Z" });
  });
  it("a skipped or failed request says why", () => {
    expect(ask(req({ status: "skipped", updated_at: at(NOW - MIN), message: "a run was still going" }))).toMatchObject({ busy: false, warn: true, note: "Skipped at 15:29: a run was still going" });
    expect(ask(req({ status: "failed", updated_at: at(NOW - MIN), message: "the machine stayed under 4 GB of free memory for 15 minutes" }))).toMatchObject({
      busy: false, warn: true, note: "Couldn't start at 15:29: the machine stayed under 4 GB of free memory for 15 minutes",
    });
  });
});

describe("shortWhen", () => {
  it("gives today's clock time, a weekday this week, else the date", () => {
    expect(shortWhen(NOW - 75 * MIN, TZ, NOW)).toBe("14:15");
    expect(shortWhen(NOW - 2 * 86400000, TZ, NOW)).toBe("Tue");
    expect(shortWhen(NOW - 9 * 86400000, TZ, NOW)).toBe("29 Sep");
    expect(shortWhen(null, TZ, NOW)).toBe("");
  });
});

describe("clearsText", () => {
  it("says what clears each status", () => {
    expect(clearsText({ ...byNumber(806).data })).toBe("Clears when the code owner approves or asks for your approval.");
    expect(clearsText(byNumber(799).data)).toBe("Clears when a run reviews it.");
  });
  it("puts the call first on a needs-you PR", () => {
    expect(clearsText(byNumber(812).data)).toBe("Clears when you make the call or review on GitHub.");
  });
});

describe("pickRoutine", () => {
  const rs = (...ids: string[]) => ids.map((id) => ({ id, version: 1, last_run_at: null, result: null }));
  it("keeps the one asked for when it has reported", () => {
    expect(pickRoutine(rs("review-bot", "review-bot-dry"), "review-bot-dry")).toBe("review-bot-dry");
  });
  it("defaults to the first one that isn't a dry run, else the first", () => {
    expect(pickRoutine(rs("a-dry", "review-bot", "review-bot-dry"), "gone")).toBe("review-bot");
    expect(pickRoutine(rs("a-dry", "b"), null)).toBe("b");
    expect(pickRoutine(rs("a-dry"), null)).toBe("a-dry");
  });
  it("is null with no routines", () => {
    expect(pickRoutine([], "review-bot")).toBeNull();
  });
});

describe("parseReviewHash", () => {
  it.each([
    ["reviews.review-bot-dry", { view: "tab", tab: "reviews", routine: "review-bot-dry" }],
    ["run.2026-10-08T181500Z", { view: "run", routine: null, stamp: "2026-10-08T181500Z" }],
    ["run.review-bot.2026-10-08T181500Z", { view: "run", routine: "review-bot", stamp: "2026-10-08T181500Z" }],
    ["pr.812", { view: "pr", routine: null, n: 812 }],
    ["pr.team.v2.812", { view: "pr", routine: "team.v2", n: 812 }],
  ])("reads #%s", (hash, route) => {
    expect(parseReviewHash(hash)).toEqual(route);
  });
  it.each(["run.2026-10-08", "pr.0", "pr.12a", "pr.-x.5", "reviews.", "item.x", "reviews"])("leaves #%s to the other routes", (hash) => {
    expect(parseReviewHash(hash)).toBeNull();
  });
  it("round-trips the hrefs it builds", () => {
    expect(parseReviewHash(runHref("2026-10-08T181500Z").slice(1))).toEqual({ view: "run", routine: null, stamp: "2026-10-08T181500Z" });
    expect(parseReviewHash(prHref(812, UI_ROUTINE).slice(1))).toEqual({ view: "pr", routine: UI_ROUTINE, n: 812 });
  });
});

describe("reviewsStale", () => {
  const routines = [{ id: "review-bot", version: 9, last_run_at: null, result: null }];
  it("is stale until the routine is loaded, and again once its head moves on", () => {
    expect(reviewsStale(routines, "review-bot", null)).toBe(true);
    expect(reviewsStale(routines, "review-bot", { routine: "review-bot", version: 9 })).toBe(false);
    expect(reviewsStale(routines, "review-bot", { routine: "review-bot", version: 8 })).toBe(true);
  });
  it("is stale when another routine is loaded, and never with none to show", () => {
    expect(reviewsStale(routines, "review-bot", { routine: "other", version: 9 })).toBe(true);
    expect(reviewsStale(routines, null, null)).toBe(false);
  });
});

describe("the e2e seed", () => {
  it("is four runs the server would store, oldest first", () => {
    const payloads = uiPayloads(NOW);
    expect(payloads.map((p) => p.result)).toEqual(["ok", "timed_out", "ok", "ok"]);
    expect(payloads.flatMap((p) => reportPayloadProblems(p))).toEqual([]);
  });
});

describe("mergeRuns", () => {
  it("puts older pages after the newest, each run once, newest first", () => {
    const runs = uiRuns(NOW), newest = runs.slice(0, 2), older = runs.slice(1);
    expect(mergeRuns(newest, older).map((r) => r.stamp)).toEqual(runs.map((r) => r.stamp));
    expect(mergeRuns(newest, []).map((r) => r.stamp)).toEqual(newest.map((r) => r.stamp));
  });
});

describe("routeHref", () => {
  it("names the routine of a run or PR page, the one shown when its link had none", () => {
    expect(routeHref({ view: "pr", routine: null, n: 812 }, "review-bot")).toBe("#pr.review-bot.812");
    expect(routeHref({ view: "pr", routine: "review-bot-dry", n: 812 }, "review-bot")).toBe("#pr.review-bot-dry.812");
    expect(routeHref({ view: "run", routine: null, stamp: "2026-10-08T181500Z" }, "review-bot")).toBe("#run.review-bot.2026-10-08T181500Z");
    expect(routeHref({ view: "item", id: "x" }, "review-bot")).toBeNull();
  });
});
