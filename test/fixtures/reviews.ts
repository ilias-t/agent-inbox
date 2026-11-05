// Synthetic review reports in the shape of docs/reviews.md "The report" (and the size of a real one:
// about 3 KB per PR), so validator and Worker tests don't carry real PR data.
import type { ReviewAsk, ReviewPr, ReviewReport, ReviewStatus } from "../../shared/types.ts";

const REPO = "https://github.com/acme/widgets";
const filler = (n: number, words: number) =>
  Array.from({ length: words }, (_, i) => ["the", "gateway", "maps", "`InvalidArgument`", "to", "a", "400", "now"][(n + i) % 8]).join(" ");

// Statuses by role, cycled so a large report has every one.
const REVIEWING: ReviewStatus[] = ["approved", "changes_requested", "waiting_author", "held_product", "held_owner", "held_ci", "pending"];
const MINE: ReviewStatus[] = ["mine_waiting", "mine_action", "mine_ready", "mine_draft"];

export function samplePr(number: number, over: Partial<ReviewPr> = {}): ReviewPr {
  const kind = number % 5; // 0-2 reviewing, 3 mine, 4 bot
  const role = kind < 3 ? "reviewing" : kind === 3 ? "mine" : "bot";
  const status = role === "reviewing" ? REVIEWING[number % REVIEWING.length] : role === "mine" ? MINE[number % MINE.length] : "bot";
  const url = `${REPO}/pull/${number}`;
  const acted = number % 4 === 0;
  return {
    number,
    title: `ENG-${number} ${filler(number, 8)}`,
    url,
    author: role === "mine" ? "you" : role === "bot" ? "app/docs-bot" : "author-" + (number % 3),
    role,
    base: "develop",
    created_at: "2026-10-06T09:12:40Z",
    updated_at: "2026-10-08T15:02:11Z",
    status,
    status_note: `${filler(number, 30)} ([review](${url}#pullrequestreview-${number}1)).`,
    needs_you: status === "held_product" ? { ask: `Ship #${number} as is?`, facts: [filler(number, 12), filler(number + 1, 12)], options: ["Approve", "Hold"] } : null,
    impact: filler(number, 40),
    risk: (["low", "medium", "high"] as const)[number % 3],
    tradeoffs: [filler(number, 25)],
    risks: [`${filler(number + 2, 25)} ([thread](${url}#discussion_r${number}2))`],
    last_action: { kind: "commented", at: "2026-10-08T16:19:01Z", url: `${url}#pullrequestreview-${number}1` },
    this_run: acted
      ? { action: "approved", url: `${url}#pullrequestreview-${number}9`, summary: filler(number, 15), changes: [`Author pushed [2 commits](${url}/commits)`] }
      : { action: "none", url: null, summary: "", changes: [] },
    threads: {
      open: 2,
      items: [1, 2].map((t) => ({ url: `${url}#discussion_r${number}${t}`, where: `go/src/gateway/engine.go:${480 + t}`, by: "you", summary: filler(number + t, 30) })),
    },
    ci: { state: "passing", url: `${url}/checks`, note: null },
    reviewers: [
      { login: "you", state: "commented" },
      { login: "reviewer-a", state: "requested" },
      { login: "reviewer-b", state: "approved" },
    ],
    assignees: [],
    mergeable: "clean",
    linear: [{ id: `ENG-${number}`, url: `https://linear.app/acme/issue/ENG-${number}` }],
    links: [{ label: "go/src/gateway/engine.go:480", url: `${REPO}/blob/70319d3/go/src/gateway/engine.go#L480` }],
    ...over,
  };
}

// `count` PRs numbered from `first`, schema 1 unless overridden.
export function sampleReport(count: number, over: Partial<ReviewReport> = {}, first = 4700): ReviewReport {
  return {
    schema: 1,
    headline: `Approved ${Math.ceil(count / 4)} PRs; one product call needs you`,
    unverified: ["No live run of the gateway change"],
    notes: ["CI was slow on develop"],
    skipped: { stale: [4237, 4105], same_patch: [4744] },
    prs: Array.from({ length: count }, (_, i) => samplePr(first + i)),
    ...over,
  };
}

// The ask for a drafted review that waits on a human OK (`<pr>-post`): it has no hold review.
export function samplePostAsk(pr: number, over: Partial<ReviewAsk> = {}): ReviewAsk {
  return {
    key: `${pr}-post`,
    type: "decision",
    title: `#${pr}: post REQUEST_CHANGES review?`,
    summary: "Changes requested: 1 should-fix, 2 nits.",
    options: [
      { id: "post", label: "Post as drafted (REQUEST_CHANGES)" },
      { id: "post_no_nits", label: "Post without the nits" },
      { id: "discard", label: "Don't post" },
    ],
    recommendation: { option: "post" },
    links: [{ label: "Files", url: `${REPO}/pull/${pr}/files` }],
    review: { pr, hold: "post", pending_review_id: 5445318292, event: "REQUEST_CHANGES", head_sha: "0123456789abcdef0123456789abcdef01234567" },
    ...over,
  };
}

export function sampleAsk(pr: number, over: Partial<ReviewAsk> = {}): ReviewAsk {
  return {
    key: `${pr}-product`,
    type: "decision",
    priority: "normal",
    title: `#${pr}: score -1 or omit score?`,
    summary: `Product call holding #${pr}. I recommend omitting score.`,
    question: "Should an abstaining decision return score: -1 or omit score?",
    context: "- v1 omits `score` when abstaining.\n- v2 would return `-1`.",
    options: [
      { id: "minus1", label: "score: -1", consequence: "Shape stays fixed.", reversible: false },
      { id: "omit", label: "Omit score", consequence: "Matches v1.", reversible: false },
    ],
    recommendation: { option: "omit", confidence: "medium", why: "Type-safe." },
    cost_of_waiting: `#${pr} stays unapproved.`,
    links: [{ label: `PR #${pr}`, url: `${REPO}/pull/${pr}` }],
    review: { pr, hold: "product", hold_review_id: 5445318292 },
    ...over,
  };
}
