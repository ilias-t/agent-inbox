// A small, readable review-bot routine for the Reviews tab: invented PRs on an invented repo (no real PR data), every
// group and run result the tab shows, and times relative to `now`, so the unit tests pin a clock and the e2e
// screenshots read as "today". Shaped like the API's GET /api/reviews/:routine (docs/reviews.md).
import type {
  ReviewAction, ReviewPr, ReviewPrRow, ReviewReport, ReviewReportPayload, ReviewRun, ReviewRunRecord, ReviewRunRequest, ReviewRunResult, ReviewStatus, RoutineReviewsResponse,
} from "../../shared/types.ts";

export const UI_REPO = "https://github.com/acme/widgets";
export const UI_ROUTINE = "review-bot";
const MIN = 60000;

// The runner's stamp for an instant: 2026-10-08T180000Z.
export function stampOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace(/:/g, "") + "Z";
}
const iso = (ms: number) => new Date(ms).toISOString();

type PrSpec = Partial<ReviewPr> & { number: number; title: string; author: string; role: ReviewPr["role"]; status: ReviewStatus; act?: ReviewAction; ago?: number };

function pr(s: PrSpec, now: number): ReviewPr {
  const url = `${UI_REPO}/pull/${s.number}`, act = s.act ?? "none", ago = s.ago ?? 120;
  const { act: _a, ago: _g, ...rest } = s;
  return {
    url, base: "main", created_at: iso(now - 3 * 86400000), updated_at: iso(now - ago * MIN),
    needs_you: null, impact: null, risk: "low", tradeoffs: [], risks: [],
    last_action: act === "none" ? null : { kind: act, at: iso(now - ago * MIN), url: `${url}#pullrequestreview-${s.number}01` },
    this_run: act === "none" ? { action: "none", url: null, summary: "", changes: [] }
      : { action: act, url: `${url}#pullrequestreview-${s.number}01`, summary: s.status_note ?? "", changes: ["Author pushed 2 commits"] },
    threads: { open: 0, items: [] }, ci: { state: "passing", url: `${url}/checks`, note: null },
    reviewers: [{ login: "you", state: act === "approved" ? "approved" : "commented" }], assignees: [], mergeable: "clean",
    linear: [], links: [],
    ...rest,
  };
}

// The PRs of the newest report, newest numbers first. `ago`: minutes since the routine's last move on it.
export function uiPrs(now: number): ReviewPr[] {
  const specs: PrSpec[] = [
    { number: 815, title: "Show export progress in the job drawer", author: "you", role: "mine", status: "mine_action", ago: 50,
      ci: { state: "failing", url: `${UI_REPO}/pull/815/checks`, note: "unit tests: 2 failures in drawer.test.ts" }, threads: { open: 2, items: [] } },
    { number: 814, title: "Move feature flags to the settings service", author: "you", role: "mine", status: "mine_waiting", ago: 200 },
    { number: 812, title: "Return 413 for oversized uploads instead of a 500", author: "mara-k", role: "reviewing", status: "held_product", act: "commented", ago: 46,
      status_note: "Commented on the size check; approval held on the product call below.",
      needs_you: {
        ask: "Should oversized uploads fail with 413, or be truncated to the limit?",
        facts: ["The web client already shows a size error for 413", "Truncating keeps imports working but drops data silently", "Mobile clients retry 5xx, not 4xx"],
        options: ["Fail with 413", "Truncate and warn"],
      },
      impact: "Uploads over 25 MB get a clear `413 Payload Too Large` instead of a 500.", risk: "medium",
      tradeoffs: ["A 413 breaks imports that rely on today's silent truncation"], risks: ["Older mobile builds show a generic error on 413"] },
    { number: 811, title: "Fix the timezone in invoice emails", author: "you", role: "mine", status: "mine_ready", ago: 300 },
    { number: 810, title: "Bump the lockfile (weekly)", author: "app/deps-bot", role: "bot", status: "bot", mergeable: "behind", ago: 900 },
    { number: 809, title: "Add a retry budget to the export queue", author: "devon", role: "reviewing", status: "approved", act: "approved", ago: 48,
      status_note: "Approved: retries capped at 5 per job with jitter.", impact: "A failing export retries at most 5 times instead of forever." },
    { number: 808, title: "The v3 search API design", author: "you", role: "mine", status: "mine_draft", ago: 1500 },
    { number: 806, title: "Cache tenant settings for 60 seconds", author: "devon", role: "reviewing", status: "held_owner", act: "commented", ago: 200,
      status_note: "Touches billing/, the owner's area: waiting on their review." },
    { number: 805, title: "Split the nightly report job by region", author: "priya-s", role: "reviewing", status: "held_ci", ago: 1300,
      status_note: "Held while the integration suite is stuck on main." },
    { number: 803, title: "Stream CSV exports instead of buffering them", author: "mara-k", role: "reviewing", status: "changes_requested", act: "changes_requested", ago: 47,
      status_note: "Asked for changes: the stream isn't closed when the client disconnects." },
    { number: 801, title: "Drop the legacy v1 webhook signer", author: "priya-s", role: "reviewing", status: "waiting_author", ago: 1440,
      last_action: { kind: "commented", at: iso(now - 1440 * MIN), url: `${UI_REPO}/pull/801#pullrequestreview-80101` } },
    { number: 799, title: "Document the rate-limit headers", author: "tomas", role: "reviewing", status: "pending", ago: 30 },
    { number: 798, title: "Changelog: 6 October entry", author: "app/docs-bot", role: "bot", status: "bot", mergeable: "conflicts", ago: 4000,
      needs_you: { ask: "Merge, close or turn off the changelog bot? Six of its PRs are open." } },
    { number: 797, title: "Rename the audit log columns", author: "tomas", role: "reviewing", status: "approved", ago: 1400,
      last_action: { kind: "approved", at: iso(now - 1400 * MIN), url: `${UI_REPO}/pull/797#pullrequestreview-79701` } },
    { number: 790, title: "Changelog: 29 September entry", author: "app/docs-bot", role: "bot", status: "bot", ago: 9000 },
  ];
  return specs.map((s) => pr(s, now));
}

function run(now: number, startedAgo: number, minutes: number | null, result: ReviewRunResult, over: Partial<ReviewRunRecord> = {}): ReviewRun {
  const started = now - startedAgo * MIN, stamp = stampOf(started), finished = minutes == null ? null : iso(started + minutes * MIN);
  const data: ReviewRunRecord = {
    stamp, started: iso(started), finished, dry: false, result, exit: result === "ok" ? 0 : result === "running" ? null : 1, error: null,
    log: `runner:/var/log/reviews/${stamp}.log`, model: "opus", headline: null, notify: null, schema: 2,
    counts: {}, actions: [], needs_you: [], unverified: [], notes: [], skipped: {}, asks: [], resolved: [],
    ...over,
  };
  return {
    routine: UI_ROUTINE, stamp, started_at: iso(started), finished_at: finished, result, dry: false,
    has_report: result === "ok" || result === "seed", report_sha: finished ? "ab".repeat(32) : null, data,
  };
}

const act = (n: number, action: ReviewAction, title: string, summary: string) =>
  ({ pr: n, title, action, url: `${UI_REPO}/pull/${n}#pullrequestreview-${n}01`, summary });

// Four runs, newest first: two finished well (the newest an hour ago), one that timed out, and an earlier good one.
export function uiRuns(now: number): ReviewRun[] {
  return [
    run(now, 75, 28, "ok", {
      headline: "Approved #809, asked for changes on #803; #812 needs your call on oversized uploads",
      notify: "NOTIFY: 1 needs you",
      actions: [
        act(809, "approved", "Add a retry budget to the export queue", "Retries capped at 5 with jitter"),
        act(803, "changes_requested", "Stream CSV exports instead of buffering them", "The stream isn't closed on disconnect"),
        act(812, "commented", "Return 413 for oversized uploads instead of a 500", "Size check reads the header, not the body"),
      ],
      needs_you: [
        { pr: 812, title: "Return 413 for oversized uploads instead of a 500", ask: "Fail with 413, or truncate?" },
        { pr: 798, title: "Changelog: 6 October entry", ask: "Merge, close or turn off the changelog bot?" },
      ],
      skipped: { same_patch: [801], stale: [702, 688] },
      unverified: ["Didn't run the upload limit against the staging bucket"],
      notes: ["CI on main was slow (35 min)"],
    }),
    run(now, 200, 21, "ok", {
      headline: "Commented on #806; nothing else changed",
      actions: [act(806, "commented", "Cache tenant settings for 60 seconds", "Asked the billing owner to look")],
    }),
    run(now, 1320, 45, "timed_out", { error: "The run hit its 45-minute limit while the integration suite was stuck", schema: null }),
    run(now, 1440, 26, "ok", {
      headline: "Approved #797; held #805 on CI",
      actions: [act(797, "approved", "Rename the audit log columns", "Migration is reversible"), act(801, "commented", "Drop the legacy v1 webhook signer", "Two callers still sign with v1")],
    }),
  ];
}

// GET /api/reviews/:routine for the routine above, plus one PR that dropped out of the newest report yesterday.
export function uiRoutine(now: number, over: { runs?: ReviewRun[]; next?: number | null; request?: ReviewRunRequest | null } = {}): RoutineReviewsResponse {
  const runs = over.runs ?? uiRuns(now), newest = runs.find((r) => r.result !== "running") ?? null;
  const last = newest ? newest.stamp : stampOf(now - 75 * MIN);
  const row = (p: ReviewPr, gone: string | null = null): ReviewPrRow => ({
    routine: UI_ROUTINE, number: p.number, url: p.url, role: p.role, status: p.status, needs_you: !!p.needs_you, data: p,
    last_stamp: last, gh: null, gone_at: gone, updated_at: iso(now - 47 * MIN),
  });
  const gone = pr({ number: 795, title: "Remove the unused theme toggle", author: "tomas", role: "reviewing", status: "approved", ago: 2000 }, now);
  return {
    routine: {
      routine: UI_ROUTINE, version: 9, last_stamp: last,
      next_run_at: over.next === undefined ? iso(now + 45 * MIN) : over.next === null ? null : iso(over.next),
      updated_at: iso(now - 47 * MIN), updated_by: "token:orch-review-bot", run_request: over.request ?? null,
    },
    prs: [...uiPrs(now).map((p) => row(p)), row(gone, iso(now - 1300 * MIN))],
    runs,
    more: false,
  };
}

// The same four runs as `agent-inbox reviews report` payloads, oldest first, to store through the real API (the
// e2e suite). Every report lists every PR; a PR's this_run is what that run did to it, which is all the Worker builds
// the run's actions from.
export function uiPayloads(now: number): ReviewReportPayload[] {
  const prs = uiPrs(now), gone = pr({ number: 795, title: "Remove the unused theme toggle", author: "tomas", role: "reviewing", status: "approved", ago: 2000 }, now);
  return uiRuns(now).reverse().map((r, i, all): ReviewReportPayload => {
    const d = r.data, did = new Map(d.actions.map((a) => [a.pr, a]));
    const report: ReviewReport | null = !r.has_report ? null : {
      schema: 2, headline: d.headline, unverified: d.unverified, notes: d.notes, skipped: d.skipped, asks: [], resolved: [],
      // #795 is only in the oldest report: the next one marks it gone.
      prs: (i === 0 ? [...prs, gone] : prs).map((p) => {
        const a = did.get(p.number);
        return { ...p, this_run: a ? { action: a.action, url: a.url, summary: a.summary, changes: [] } : { action: "none", url: null, summary: "", changes: [] } };
      }),
    };
    return {
      stamp: r.stamp, started_at: r.started_at, finished_at: r.finished_at!, result: r.result as ReviewReportPayload["result"], exit: d.exit, error: d.error,
      log: d.log, model: d.model, dry: false, next_run_at: i === all.length - 1 ? new Date(now + 45 * MIN).toISOString() : null, report,
    };
  });
}

// `count` runs older than the four above, an hour apart, that ended without a report (enough to need Load older).
export function uiOlderPayloads(now: number, count: number): ReviewReportPayload[] {
  return Array.from({ length: count }, (_, i) => {
    const started = now - (2 * 86400000 + (count - i) * 3600000);
    return { stamp: stampOf(started), started_at: iso(started), finished_at: iso(started + 5 * MIN), result: "failed" as const, exit: 1,
      error: "Older run " + (count - i) + " ended before its report", dry: false, report: null };
  });
}
