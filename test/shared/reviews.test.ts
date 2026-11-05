// shared/reviews.ts: the report validator (docs/reviews.md "The report": fields, enums, list caps and
// schema 2's asks/resolved) and the request bodies of POST /api/reviews/report and /runs/:stamp/start.
import { describe, expect, it } from "vitest";
import {
  jsonBytes,
  LIMITS,
  reportPayloadProblems,
  reportProblems,
  startPayloadProblems,
  stampTime,
} from "../../shared/reviews.ts";
import type { ReviewPr, ReviewReport } from "../../shared/types.ts";
import { sampleAsk, samplePostAsk, samplePr, sampleReport } from "../fixtures/reviews.ts";

// One PR (#4701) with `over` applied; `null` deletes a key, as a run that left it out.
function withPr(over: Record<string, unknown>, report: Partial<ReviewReport> = {}): unknown {
  const pr: Record<string, unknown> = { ...samplePr(4701) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete pr[k];
    else pr[k] = v;
  }
  return { ...sampleReport(0), prs: [pr], ...report };
}
const schema2 = (over: Partial<ReviewReport> = {}): ReviewReport =>
  sampleReport(3, { schema: 2, asks: [sampleAsk(4701)], resolved: [{ id: "review-bot-4700-product", version: 3, pr: 4700, review_url: "https://github.com/acme/widgets/pull/4700#pullrequestreview-1" }], ...over });

describe("reportProblems: valid reports", () => {
  it("accepts a 45-PR schema 1 report in the routine's real shape (about 3 KB a PR)", () => {
    const r = sampleReport(45);
    expect(reportProblems(r)).toEqual([]);
    const sizes = r.prs.map(jsonBytes);
    expect(Math.min(...sizes)).toBeGreaterThan(2000);
    expect(Math.max(...sizes)).toBeLessThan(LIMITS.prBytes);
  });

  it("reads a report without schema as schema 1, as the runner's jq check did", () => {
    const { schema: _schema, ...r } = sampleReport(2);
    expect(reportProblems(r)).toEqual([]);
  });

  it("accepts nulls and absences for every optional field", () => {
    const bare = { number: 4701, title: "t", url: "https://github.com/acme/widgets/pull/4701", author: "a", role: "reviewing", status: "pending", this_run: { action: "none" } };
    expect(reportProblems({ prs: [bare] })).toEqual([]);
    const nulls = Object.fromEntries(Object.keys(samplePr(1)).filter((k) => !(k in bare)).map((k) => [k, null]));
    expect(reportProblems({ prs: [{ ...bare, ...nulls }], headline: null, unverified: null, notes: null, skipped: null })).toEqual([]);
  });

  it("keeps fields it doesn't know (a later schema's additions stay in the stored entry)", () => {
    expect(reportProblems(withPr({ mystery: { a: 1 } }, { extra: true }))).toEqual([]);
  });

  it("accepts a schema 2 report with asks and resolved, and with both empty", () => {
    expect(reportProblems(schema2())).toEqual([]);
    expect(reportProblems(schema2({ asks: [], resolved: [] }))).toEqual([]);
  });
});

describe("reportProblems: required fields, enums and unique PRs", () => {
  it("refuses a top level that isn't an object, or prs that isn't a list", () => {
    expect(reportProblems([])).toEqual(["the top level is not an object"]);
    expect(reportProblems("x")).toEqual(["the top level is not an object"]);
    expect(reportProblems({})).toEqual(["prs is missing or not an array"]);
    expect(reportProblems({ prs: {} })).toEqual(["prs is missing or not an array"]);
  });

  it("requires number, title, url, author, role, status and this_run.action on every PR", () => {
    expect(reportProblems({ prs: [7] })).toEqual(["prs[0] is not an object"]);
    expect(reportProblems(withPr({ number: undefined }))).toContain("prs[0]: number is missing or not a positive integer");
    expect(reportProblems(withPr({ number: 47.5 }))).toContain("prs[0]: number is missing or not a positive integer");
    for (const k of ["title", "url", "author"]) {
      expect(reportProblems(withPr({ [k]: undefined }))).toContain("#4701: title, url and author must be strings");
    }
    expect(reportProblems(withPr({ role: undefined }))).toContain("#4701: role is required");
    expect(reportProblems(withPr({ status: undefined }))).toContain("#4701: status is required");
    const action = "#4701: this_run.action must be approved, changes_requested, commented, replied, drafted or none";
    expect(reportProblems(withPr({ this_run: undefined }))).toContain(action);
    expect(reportProblems(withPr({ this_run: { action: "merged" } }))).toContain(action);
  });

  it("accepts the drafted action", () => {
    expect(reportProblems(withPr({ this_run: { action: "drafted" } }))).toEqual([]);
  });

  it("accepts the awaiting_ok status", () => {
    expect(reportProblems(withPr({ status: "awaiting_ok" }))).toEqual([]);
  });

  it("refuses unknown enum values: role, status, risk", () => {
    expect(reportProblems(withPr({ role: "owner" }))).toEqual(['#4701: unknown role "owner"']);
    expect(reportProblems(withPr({ status: "held" }))).toEqual(['#4701: unknown status "held"']);
    expect(reportProblems(withPr({ risk: "severe" }))).toEqual(['#4701: unknown risk "severe"']);
  });

  it("refuses two entries with the same PR number", () => {
    const r = sampleReport(2);
    r.prs[1].number = r.prs[0].number;
    expect(reportProblems(r)).toEqual(["two entries share a PR number"]);
  });

  it("needs this_run.changes to be a list and needs_you to be an object or null", () => {
    expect(reportProblems(withPr({ this_run: { action: "none", changes: "pushed" } }))).toEqual(["#4701: this_run.changes must be a list"]);
    expect(reportProblems(withPr({ needs_you: "decide" }))).toEqual(["#4701: needs_you must be an object or null"]);
  });
});

describe("reportProblems: shapes the Worker and the tab rely on", () => {
  it("needs_you has an ask, at most 3 facts and 4 options", () => {
    expect(reportProblems(withPr({ needs_you: { facts: [] } }))).toEqual(["#4701: needs_you.ask is required"]);
    expect(reportProblems(withPr({ needs_you: { ask: "  " } }))).toEqual(["#4701: needs_you.ask must not be empty"]);
    expect(reportProblems(withPr({ needs_you: { ask: "x", facts: ["a", "b", "c", "d"] } }))).toEqual(["#4701: needs_you.facts has 4 entries, at most 3"]);
    expect(reportProblems(withPr({ needs_you: { ask: "x", options: ["a", "b", "c", "d", "e"] } }))).toEqual(["#4701: needs_you.options has 5 entries, at most 4"]);
  });

  it("the PR url is https (it is the GitHub hook's match key)", () => {
    expect(reportProblems(withPr({ url: "http://github.com/acme/widgets/pull/4701" }))).toEqual(["#4701: url must be an https url"]);
    expect(reportProblems(withPr({ url: "github.com/acme/widgets/pull/4701" }))).toEqual(["#4701: url must be an https url"]);
  });

  it("refuses unknown ci, mergeable and reviewer states", () => {
    expect(reportProblems(withPr({ ci: { state: "green" } }))).toEqual(['#4701: ci.unknown state "green"']);
    expect(reportProblems(withPr({ ci: { url: null } }))).toEqual(["#4701: ci.state is required"]);
    expect(reportProblems(withPr({ ci: "passing" }))).toEqual(["#4701: ci must be an object or null"]);
    expect(reportProblems(withPr({ mergeable: "dirty" }))).toEqual(['#4701: unknown mergeable "dirty"']);
    expect(reportProblems(withPr({ reviewers: [{ login: "a", state: "dismissed" }] }))).toEqual(['#4701: reviewers[0] has unknown state "dismissed"']);
    expect(reportProblems(withPr({ reviewers: ["a"] }))).toEqual(["#4701: reviewers[0] must be {login, state}"]);
  });

  it("checks link urls, times and the types of the text fields", () => {
    expect(reportProblems(withPr({ links: [{ label: "x", url: "ftp://x" }] }))).toEqual(["#4701: links[0] must be {label, url} with an http(s) url"]);
    expect(reportProblems(withPr({ linear: [{ id: "ENG-1" }] }))).toEqual(["#4701: linear[0] must be {id, url}"]);
    expect(reportProblems(withPr({ created_at: "last tuesday" }))).toEqual(["#4701: created_at must be an ISO 8601 time"]);
    expect(reportProblems(withPr({ impact: 3 }))).toEqual(["#4701: impact must be a string"]);
    expect(reportProblems(withPr({ this_run: { action: "approved", url: "#review" } }))).toEqual(["#4701: this_run.url must be an http(s) url or null"]);
    expect(reportProblems(withPr({ threads: { open: -1 } }))).toEqual(["#4701: threads.open must be a whole number"]);
    expect(reportProblems(withPr({ assignees: [1] }))).toEqual(["#4701: assignees[0] must be a string"]);
    expect(reportProblems(withPr({ last_action: { at: "soon" } }))).toEqual(["#4701: last_action.at must be an ISO 8601 time"]);
  });

  it("top-level fields: headline a string, unverified and notes lists of strings, skipped PR number lists", () => {
    expect(reportProblems({ ...sampleReport(1), headline: ["x"] })).toEqual(["headline must be a string"]);
    expect(reportProblems({ ...sampleReport(1), notes: "x" })).toEqual(["notes must be a list"]);
    expect(reportProblems({ ...sampleReport(1), unverified: [3] })).toEqual(["unverified[0] must be a string"]);
    expect(reportProblems({ ...sampleReport(1), skipped: [4237] })).toEqual(["skipped must be an object of PR number lists"]);
    expect(reportProblems({ ...sampleReport(1), skipped: { stale: ["4237"] } })).toEqual(["skipped.stale[0] must be a PR number"]);
  });
});

describe("reportProblems: sizes", () => {
  it("caps each list at its maximum", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => `entry ${i}`);
    expect(reportProblems(withPr({ tradeoffs: n(4) }))).toEqual(["#4701: tradeoffs has 4 entries, at most 3"]);
    expect(reportProblems(withPr({ risks: n(4) }))).toEqual(["#4701: risks has 4 entries, at most 3"]);
    expect(reportProblems(withPr({ this_run: { action: "none", changes: n(5) } }))).toEqual(["#4701: this_run.changes has 5 entries, at most 4"]);
    expect(reportProblems(withPr({ threads: { open: 6, items: n(6).map((summary) => ({ summary })) } }))).toEqual(["#4701: threads.items has 6 entries, at most 5"]);
    const links = n(6).map((label) => ({ label, url: "https://x.test" }));
    expect(reportProblems(withPr({ links }))).toEqual(["#4701: links has 6 entries, at most 5"]);
    expect(reportProblems({ ...sampleReport(1), unverified: n(7) })).toEqual(["unverified has 7 entries, at most 6"]);
    expect(reportProblems({ ...sampleReport(1), notes: n(7) })).toEqual(["notes has 7 entries, at most 6"]);
  });

  it("refuses a PR entry over 16 KB, and one exactly at it passes", () => {
    const base = samplePr(4701, { impact: "" });
    const room = LIMITS.prBytes - jsonBytes(base);
    // impact is capped at 2000 chars, so the padding goes in an extra field.
    const at = { ...base, padding: "x".repeat(room - jsonBytes({ padding: "" }) + 1) };
    expect(jsonBytes(at)).toBe(LIMITS.prBytes);
    expect(reportProblems({ prs: [at] })).toEqual([]);
    const over = { ...at, padding: at.padding + "x" };
    expect(reportProblems({ prs: [over] })).toEqual([`#4701: the entry is ${LIMITS.prBytes + 1} bytes as JSON, over ${LIMITS.prBytes}`]);
  });

  it("counts bytes, not characters", () => {
    const base = samplePr(4701);
    const pad = "é".repeat(Math.ceil((LIMITS.prBytes - jsonBytes(base)) / 2) + 1); // 2 bytes each in UTF-8
    expect(pad.length).toBeLessThan(LIMITS.prBytes - jsonBytes(base));
    expect(reportProblems({ prs: [{ ...base, padding: pad }] })[0]).toMatch(/over 16384$/);
  });

  it("caps text fields and the number of PRs", () => {
    expect(reportProblems(withPr({ status_note: "x".repeat(2001) }))).toEqual(["#4701: status_note is over 2000 characters"]);
    expect(reportProblems({ ...sampleReport(1), headline: "x".repeat(2001) })).toEqual(["headline is over 2000 characters"]);
    const many = { prs: Array.from({ length: LIMITS.prs + 1 }, (_, i) => ({ ...samplePr(1), number: i + 1 })) };
    expect(reportProblems(many)).toEqual([`prs has ${LIMITS.prs + 1} entries, at most ${LIMITS.prs}`]);
  });
});

describe("reportProblems: schema 1 and 2", () => {
  it("refuses a schema it doesn't read", () => {
    expect(reportProblems(sampleReport(1, { schema: 3 as never }))).toEqual(["unknown schema 3: this server reads 1 and 2"]);
    expect(reportProblems(sampleReport(1, { schema: "2" as never }))).toEqual(['unknown schema "2": this server reads 1 and 2']);
  });

  it("schema 2 requires asks and resolved", () => {
    const { asks: _a, resolved: _r, ...r } = schema2();
    expect(reportProblems(r)).toEqual([
      "asks is required with schema 2 (an empty list when there are none)",
      "resolved is required with schema 2 (an empty list when there are none)",
    ]);
    expect(reportProblems(schema2({ asks: {} as never }))).toEqual(["asks must be a list"]);
  });

  it("schema 1 may carry asks and resolved, checked the same way", () => {
    expect(reportProblems(sampleReport(3, { asks: [sampleAsk(4701)], resolved: [] }))).toEqual([]);
    expect(reportProblems(sampleReport(3, { asks: [sampleAsk(4701, { type: "poll" as never })] }))).toEqual(['ask 4701-product: unknown type "poll"']);
  });
});

describe("reportProblems: asks", () => {
  const ask = (over: Record<string, unknown>) => reportProblems(schema2({ asks: [{ ...sampleAsk(4701), ...over } as never] }));

  it("needs a key of <pr>-<hold> that matches review.pr and review.hold", () => {
    expect(ask({ key: "product" })).toEqual(['asks[0]: key must be "<pr>-<hold>", e.g. "4737-product"; got "product"']);
    expect(ask({ key: undefined })).toEqual(['asks[0]: key must be "<pr>-<hold>", e.g. "4737-product"; got undefined']);
    expect(ask({ key: "4701-owner" })).toEqual(['ask 4701-owner: key must be "<review.pr>-<review.hold>", "4701-product"']);
  });

  it("accepts a post ask: key <pr>-post, no hold_review_id, with pending_review_id, event and head_sha", () => {
    expect(reportProblems(schema2({ asks: [samplePostAsk(4701)] }))).toEqual([]);
    expect(reportProblems(schema2({ asks: [samplePostAsk(4701, { review: { pr: 4701, hold: "post" } })] }))).toEqual([]);
    expect(ask({ ...samplePostAsk(4701), key: "4701-product" })).toEqual(['ask 4701-product: key must be "<review.pr>-<review.hold>", "4701-post"']);
  });

  it("checks the post ask's review fields", () => {
    const post = (review: Record<string, unknown>) => ask({ ...samplePostAsk(4701), review: { ...samplePostAsk(4701).review, ...review } });
    expect(post({ pending_review_id: null })).toEqual([]); // a dry run drafts nothing on GitHub
    expect(post({ event: "MERGE" })).toEqual(["ask 4701-post: review.event must be one of APPROVE, COMMENT, REQUEST_CHANGES"]);
    expect(post({ event: "approve" })).toEqual(["ask 4701-post: review.event must be one of APPROVE, COMMENT, REQUEST_CHANGES"]);
    expect(post({ pending_review_id: "5445" })).toEqual(["ask 4701-post: review.pending_review_id must be a positive integer"]);
    expect(post({ pending_review_id: 0 })).toEqual(["ask 4701-post: review.pending_review_id must be a positive integer"]);
    expect(post({ head_sha: 123 })).toEqual(["ask 4701-post: review.head_sha must be a non-empty string"]);
    expect(post({ head_sha: "" })).toEqual(["ask 4701-post: review.head_sha must be a non-empty string"]);
  });

  it("a post ask may name its draft by draft_id (the routine keeps the draft itself) instead of pending_review_id", () => {
    const post = (review: Record<string, unknown>) => ask({ ...samplePostAsk(4701), review: { pr: 4701, hold: "post", event: "APPROVE", head_sha: "abc", ...review } });
    expect(post({ draft_id: "4701-2026-10-16T230136Z" })).toEqual([]);
    expect(post({ draft_id: null })).toEqual([]);
    expect(post({ draft_id: "" })).toEqual(["ask 4701-post: review.draft_id must be 1-100 characters with no spaces"]);
    expect(post({ draft_id: "a b" })).toEqual(["ask 4701-post: review.draft_id must be 1-100 characters with no spaces"]);
    expect(post({ draft_id: "x".repeat(101) })).toEqual(["ask 4701-post: review.draft_id must be 1-100 characters with no spaces"]);
    expect(post({ draft_id: 5445 })).toEqual(["ask 4701-post: review.draft_id must be 1-100 characters with no spaces"]);
    expect(post({ draft_id: "d1", pending_review_id: 5445 })).toEqual(["ask 4701-post: review has both pending_review_id and draft_id; a draft is one or the other"]);
    expect(reportProblems(schema2({ asks: [{ ...sampleAsk(4701), review: { pr: 4701, hold: "product", draft_id: "d1" } } as never] })))
      .toEqual(["ask 4701-product: review.draft_id is only for a post ask"]);
  });

  it("a product ask may cover other PRs of the same call (review.also): in prs, distinct, not its own, at most 5", () => {
    const both = (also: unknown, hold = "product") =>
      reportProblems(schema2({ asks: [{ ...sampleAsk(4701), key: `4701-${hold}`, review: { pr: 4701, hold, also } } as never] }));
    expect(both([4702])).toEqual([]);
    expect(both([])).toEqual([]);
    expect(both([4702], "owner")).toEqual(["ask 4701-owner: review.also is only for a product call"]);
    expect(both([4999])).toEqual(["ask 4701-product: review.also #4999 is not in the report's prs"]);
    expect(both([4701])).toEqual(["ask 4701-product: review.also #4701 is the ask's own PR"]);
    expect(both([4702, 4702])).toEqual(["ask 4701-product: review.also lists #4702 twice"]);
    expect(both("4702")).toEqual(["ask 4701-product: review.also must be a list of PR numbers"]);
    expect(both([1, 2, 3, 4, 5, 6])).toEqual(["ask 4701-product: review.also has 6 PRs, at most 5"]);
  });

  it("refuses two asks with the same key", () => {
    expect(reportProblems(schema2({ asks: [sampleAsk(4701), sampleAsk(4701)] }))).toEqual(["ask 4701-product: two asks share this key"]);
  });

  it("needs review.pr to be a PR in the report and review.hold a hold marker", () => {
    expect(reportProblems(schema2({ asks: [sampleAsk(4999)] }))).toEqual(["ask 4999-product: review.pr #4999 is not in the report's prs"]);
    expect(ask({ review: { pr: 4701, hold: "legal" }, key: "4701-legal" })).toEqual(["ask 4701-legal: review.hold must be one of product, owner, ci, post"]);
    expect(ask({ review: null })).toEqual(["ask 4701-product: review must be {pr, hold}"]);
    expect(ask({ review: { pr: 4701, hold: "product", hold_review_id: "5445" } })).toEqual([
      "ask 4701-product: review.hold_review_id must be a positive integer or null",
    ]);
  });

  it("needs 2-4 options with unique ids, none of them other", () => {
    const opt = (id: string) => ({ id, label: id });
    expect(ask({ options: [opt("a")] })).toEqual(["ask 4701-product: options must be a list of 2-4 options", 'ask 4701-product: recommendation.option "omit" is not one of the options']);
    expect(ask({ options: ["a", "b", "c", "d", "e"].map(opt), recommendation: undefined })).toEqual(["ask 4701-product: options must be a list of 2-4 options"]);
    expect(ask({ options: [opt("a"), opt("a")], recommendation: undefined })).toEqual(['ask 4701-product: options[1] id "a" is used twice']);
    expect(ask({ options: [opt("a"), opt("other")], recommendation: undefined })).toEqual(['ask 4701-product: options[1] id "other" is every item\'s own: leave it out']);
    expect(ask({ options: [opt("a"), { id: "b" }], recommendation: undefined })).toEqual(["ask 4701-product: options[1] label is required"]);
    expect(ask({ options: [opt("a"), { ...opt("b"), reversible: "no" }], recommendation: undefined })).toEqual(["ask 4701-product: options[1] reversible must be true or false"]);
  });

  it("checks the recommendation, type, priority and title", () => {
    expect(ask({ recommendation: { option: "maybe" } })).toEqual(['ask 4701-product: recommendation.option "maybe" is not one of the options']);
    expect(ask({ recommendation: { option: "omit", confidence: "sure" } })).toEqual(['ask 4701-product: recommendation.unknown confidence "sure"']);
    expect(ask({ type: undefined })).toEqual(["ask 4701-product: type is required"]);
    expect(ask({ priority: "urgent" })).toEqual(['ask 4701-product: unknown priority "urgent"']);
    expect(ask({ title: "" })).toEqual(["ask 4701-product: title must not be empty"]);
    expect(ask({ links: [{ label: "x", url: "javascript:alert(1)" }] })).toEqual(["ask 4701-product: links[0] must be {label, url} with an http(s) url"]);
    expect(ask({ context: "x".repeat(LIMITS.text + 1) })).toEqual([`ask 4701-product: context is over ${LIMITS.text} characters`]);
  });

  it("caps the number of asks", () => {
    const report = sampleReport(LIMITS.asks + 1, { schema: 2, resolved: [] });
    report.asks = report.prs.map((p) => sampleAsk(p.number));
    expect(reportProblems(report)).toEqual([`asks has ${LIMITS.asks + 1} entries, at most ${LIMITS.asks}`]);
  });
});

describe("reportProblems: answers", () => {
  const answers = (...as: unknown[]) => reportProblems(schema2({ answers: as as never }));
  const ok = { id: "review-bot-4700-product", text: "allow_abstain is new in #4736." };

  it("is optional, and takes the answers to questions asked on the routine's items", () => {
    expect(reportProblems(schema2({}))).toEqual([]);
    expect(answers(ok)).toEqual([]);
  });

  it("needs an item id and the answer's text, each id once", () => {
    expect(reportProblems(schema2({ answers: "x" as never }))).toEqual(["answers must be a list"]);
    expect(answers("hi")).toEqual(["answers[0]: must be {id, text}"]);
    expect(answers({ ...ok, id: "-bad" })).toEqual(['answers[0]: id "-bad" is not an item id']);
    expect(answers({ ...ok, text: "" })).toEqual(["answers[0]: text must be 1-8000 characters"]);
    expect(answers({ ...ok, text: "x".repeat(8001) })).toEqual(["answers[0]: text must be 1-8000 characters"]);
    expect(answers(ok, { ...ok })).toEqual(['answers[1]: id "review-bot-4700-product" is answered twice']);
  });
});

describe("reportProblems: resolved", () => {
  const resolved = (...rs: unknown[]) => reportProblems(schema2({ resolved: rs as never }));
  const ok = { id: "review-bot-4700-product", version: 3, pr: 4700, review_url: null };

  it("accepts an entry with no review url (the user already answered on GitHub)", () => {
    expect(resolved(ok)).toEqual([]);
    const { review_url: _u, ...noUrl } = ok;
    expect(resolved(noUrl)).toEqual([]);
  });

  it("needs an item id, its version and the PR, each id once", () => {
    expect(resolved("review-bot-4700-product")).toEqual(["resolved[0]: must be {id, version, pr, review_url}"]);
    expect(resolved({ ...ok, id: "-bad" })).toEqual(['resolved[0]: id "-bad" is not an item id']);
    expect(resolved({ ...ok, version: 0 })).toEqual(["resolved[0]: version must be the item's version, a positive integer"]);
    expect(resolved({ ...ok, pr: "4700" })).toEqual(["resolved[0]: pr must be a PR number"]);
    expect(resolved({ ...ok, review_url: "nope" })).toEqual(["resolved[0]: review_url must be an http(s) url or null"]);
    expect(resolved(ok, { ...ok })).toEqual(['resolved[1]: id "review-bot-4700-product" is listed twice']);
  });
});

describe("request bodies", () => {
  const payload = (over: Record<string, unknown> = {}) => ({ stamp: "2026-10-08T180000Z", result: "ok", report: sampleReport(2), ...over });

  it("stampTime reads the runner's stamp and refuses what isn't a real time", () => {
    expect(stampTime("2026-10-08T180000Z")).toBe("2026-10-08T18:00:00.000Z");
    expect(stampTime("2026-10-08T18:00:00Z")).toBeNull();
    expect(stampTime("2026-02-30T120000Z")).toBeNull();
    expect(stampTime("2026-10-08T250000Z")).toBeNull();
    expect(stampTime("2026-10-08T180000Z-dry-run")).toBeNull();
  });

  it("a report body: valid as the runner sends it", () => {
    expect(reportPayloadProblems(payload())).toEqual([]);
    expect(
      reportPayloadProblems(
        payload({
          started_at: "2026-10-08T18:00:00Z",
          finished_at: "2026-10-08T18:28:00Z",
          exit: 0,
          error: null,
          log: "runner:/var/log/reviews/2026-10-08T180000Z.log",
          notify: "NOTIFY: 1 needs you",
          dry: false,
          next_run_at: "2026-10-08T20:00:00Z",
          model: "opus",
        }),
      ),
    ).toEqual([]);
    expect(reportPayloadProblems(payload({ result: "failed", report: null, exit: 1, error: "timeout" }))).toEqual([]);
  });

  it("a report body: the result decides whether a report must be there", () => {
    expect(reportPayloadProblems(payload({ report: null }))).toEqual(["a ok run needs its report"]);
    expect(reportPayloadProblems(payload({ result: "seed", report: undefined }))).toEqual(["a seed run needs its report"]);
    expect(reportPayloadProblems(payload({ result: "report_invalid" }))).toEqual(["a report_invalid run has no report: send report: null"]);
    expect(reportPayloadProblems(payload({ result: "report_invalid", report: null }))).toEqual([]);
    expect(reportPayloadProblems(payload({ result: "running" }))).toEqual(['unknown result "running"']);
    expect(reportPayloadProblems(payload({ result: undefined }))).toEqual(["result is required"]);
  });

  it("a report body: the report's own problems, prefixed", () => {
    expect(reportPayloadProblems(payload({ report: { prs: "none" } }))).toEqual(["report: prs is missing or not an array"]);
  });

  it("a report body: field types", () => {
    expect(reportPayloadProblems([])).toEqual(["the body must be an object"]);
    expect(reportPayloadProblems(payload({ stamp: "today" }))).toEqual(['stamp must be a UTC stamp like "2026-10-08T180000Z"; got "today"']);
    expect(reportPayloadProblems(payload({ exit: "0" }))).toEqual(["exit must be an integer or null"]);
    expect(reportPayloadProblems(payload({ dry: 1 }))).toEqual(["dry must be true or false"]);
    expect(reportPayloadProblems(payload({ finished_at: "later" }))).toEqual(["finished_at must be an ISO 8601 time"]);
    expect(reportPayloadProblems(payload({ log: "x".repeat(LIMITS.log + 1) }))).toEqual([`log is over ${LIMITS.log} characters`]);
  });

  it("a start body: the stamp from the path and optional fields", () => {
    expect(startPayloadProblems("2026-10-08T180000Z", {})).toEqual([]);
    expect(startPayloadProblems("2026-10-08T180000Z", { started_at: "2026-10-08T18:00:01Z", dry: true, log: "runner:x", model: "opus", next_run_at: null })).toEqual([]);
    expect(startPayloadProblems("x", {})).toEqual(['stamp must be a UTC stamp like "2026-10-08T180000Z"; got "x"']);
    expect(startPayloadProblems("2026-10-08T180000Z", { dry: "yes" })).toEqual(["dry must be true or false"]);
    expect(startPayloadProblems("2026-10-08T180000Z", null)).toEqual(["the body must be an object"]);
  });

  it("returns every problem, in document order", () => {
    const r = sampleReport(2);
    (r.prs[0] as Partial<ReviewPr>).status = "x" as never;
    (r.prs[1] as Partial<ReviewPr>).risk = "y" as never;
    expect(reportProblems(r)).toEqual(['#4700: unknown status "x"', '#4701: unknown risk "y"']);
  });
});
