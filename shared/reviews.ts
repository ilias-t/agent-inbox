// The Reviews contract's validation (docs/reviews.md "The report"), pure so the Worker and the tests share it:
// required fields, the enums, unique PR numbers, needs_you an object, the list caps, a 16 KB cap per PR, the types
// of the fields the Worker reads, and schema 2's `asks` and `resolved`. A runner may pre-check a report locally;
// this is the check that decides.
//
// Each check returns every problem it finds, one line each ("#4763: unknown status \"x\""), in document
// order; [] means valid. The Worker answers 400 with the first few, so the runner can still store the run as
// `report_invalid` with the reason.

import type {
  ReviewAction,
  ReviewCiState,
  ReviewerState,
  ReviewPostEvent,
  ReviewHold,
  ReviewMergeable,
  ReviewRisk,
  ReviewRole,
  ReviewRunRequest,
  ReviewRunRequestUpdate,
  ReviewRunResult,
  ReviewStatus,
} from "./types.ts";

export const REVIEW_ROLES = ["reviewing", "mine", "bot"] as const satisfies readonly ReviewRole[];
export const REVIEW_STATUSES = [
  "held_product",
  "held_owner",
  "held_ci",
  "awaiting_ok",
  "changes_requested",
  "waiting_author",
  "pending",
  "approved",
  "mine_action",
  "mine_waiting",
  "mine_ready",
  "mine_draft",
  "bot",
] as const satisfies readonly ReviewStatus[];
export const REVIEW_RISKS = ["low", "medium", "high"] as const satisfies readonly ReviewRisk[];
export const REVIEW_ACTIONS = ["approved", "changes_requested", "commented", "replied", "drafted", "none"] as const satisfies readonly ReviewAction[];
export const CI_STATES = ["passing", "failing", "pending", "none"] as const satisfies readonly ReviewCiState[];
export const MERGEABLE = ["clean", "blocked", "conflicts", "behind", "unknown"] as const satisfies readonly ReviewMergeable[];
export const REVIEWER_STATES = ["approved", "changes_requested", "commented", "requested"] as const satisfies readonly ReviewerState[];
export const HOLDS = ["product", "owner", "ci", "post"] as const satisfies readonly ReviewHold[];
export const REVIEW_EVENTS = ["APPROVE", "COMMENT", "REQUEST_CHANGES"] as const satisfies readonly ReviewPostEvent[];
export const ASK_TYPES = ["decision", "proposal", "blocker", "info"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
// What a report may end with; `running` is only ever written by a start.
export const FINISHED_RESULTS = ["ok", "failed", "timed_out", "report_invalid", "seed"] as const satisfies readonly Exclude<
  ReviewRunResult,
  "running"
>[];
export const SCHEMAS = [1, 2] as const;

// The runner's stamp: `date -u +%Y-%m-%dT%H%M%SZ`. Fixed width, so string order is time order.
export const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;

export const LIMITS = {
  prs: 300, // PRs per report (45 today)
  prBytes: 16 * 1024, // one PR entry as JSON, UTF-8 (the largest today is about 4 KB)
  unverified: 6,
  notes: 6,
  tradeoffs: 3,
  risks: 3,
  changes: 4, // this_run.changes
  threadItems: 5,
  links: 5,
  facts: 3, // needs_you.facts
  needsOptions: 4, // needs_you.options
  askOptionsMin: 2,
  askOptionsMax: 4,
  asks: 50, // the runner reconciles in batches of at most 50 ops
  resolved: 100,
  also: 5, // review.also: the other PRs one product call covers
  answers: 50,
  answer: 8000, // an answer's text, as a Q&A message
  skipped: 500, // numbers per skipped list
  line: 2000, // headline, unverified and notes entries, the other short text fields
  text: 8000, // an ask's context, a run's error
  log: 1000,
} as const;

// The ask key, "<pr>-<hold>". It becomes part of an item id (`<routine>-<key>`, then `-2`, `-3` ...), so it
// stays well inside the item id rule (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$).
export const ASK_KEY_RE = /^\d{1,9}-[a-z][a-z0-9_]{0,31}$/;
// Option ids as the item page and the ntfy buttons use them; "other" is every item's own.
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string) => o[k] !== undefined && o[k] !== null;
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isHttpUrl = (v: unknown) => typeof v === "string" && /^https?:\/\/\S+$/i.test(v);
const isHttpsUrl = (v: unknown) => typeof v === "string" && /^https:\/\/\S+$/i.test(v);
const isTime = (v: unknown) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const inEnum = (xs: readonly unknown[], v: unknown) => xs.includes(v);
const show = (v: unknown) => (v === undefined ? "undefined" : String(JSON.stringify(v)).slice(0, 60));
const utf8 = new TextEncoder();
export const jsonBytes = (v: unknown) => utf8.encode(JSON.stringify(v)).byteLength;

// --- Field checks: each pushes "<where><field> ..." onto `out` -----------------------------------------------

class Checker {
  readonly out: string[];
  readonly where: string;
  constructor(out: string[], where: string) {
    this.out = out;
    this.where = where;
  }
  bad(msg: string): void {
    this.out.push(`${this.where}${msg}`);
  }
  // A string (or null/absent unless required) of at most `max` chars.
  str(o: Obj, k: string, { required = false, max = LIMITS.line as number } = {}): void {
    const v = o[k];
    if (v === undefined || v === null) {
      if (required) this.bad(`${k} is required`);
      return;
    }
    if (typeof v !== "string") return this.bad(`${k} must be a string`);
    if (required && !v.trim()) return this.bad(`${k} must not be empty`);
    if (v.length > max) this.bad(`${k} is over ${max} characters`);
  }
  time(o: Obj, k: string): void {
    if (has(o, k) && !isTime(o[k])) this.bad(`${k} must be an ISO 8601 time`);
  }
  oneOf(o: Obj, k: string, xs: readonly unknown[], { required = false } = {}): void {
    if (!has(o, k)) {
      if (required) this.bad(`${k} is required`);
      return;
    }
    if (!inEnum(xs, o[k])) this.bad(`unknown ${k} ${show(o[k])}`);
  }
  // An array (or null/absent) of at most `max` entries, each checked by `each`.
  list(o: Obj, k: string, max: number, each: (v: unknown) => string | null): void {
    const v = o[k];
    if (v === undefined || v === null) return;
    if (!Array.isArray(v)) return this.bad(`${k} must be a list`);
    if (v.length > max) this.bad(`${k} has ${v.length} entries, at most ${max}`);
    v.forEach((x, i) => {
      const why = each(x);
      if (why) this.bad(`${k}[${i}] ${why}`);
    });
  }
  strings(o: Obj, k: string, max: number): void {
    this.list(o, k, max, (x) => (typeof x !== "string" ? "must be a string" : x.length > LIMITS.line ? `is over ${LIMITS.line} characters` : null));
  }
  links(o: Obj, k: string, max: number): void {
    this.list(o, k, max, (x) => (isObj(x) && typeof x.label === "string" && isHttpUrl(x.url) ? null : "must be {label, url} with an http(s) url"));
  }
  url(o: Obj, k: string): void {
    if (has(o, k) && !isHttpUrl(o[k])) this.bad(`${k} must be an http(s) url or null`);
  }
}

// --- A PR entry ----------------------------------------------------------------------------------------------

function prProblems(pr: unknown, i: number, out: string[]): void {
  if (!isObj(pr)) {
    out.push(`prs[${i}] is not an object`);
    return;
  }
  const where = isPosInt(pr.number) ? `#${pr.number}: ` : `prs[${i}]: `;
  const c = new Checker(out, where);
  if (!isPosInt(pr.number)) c.bad("number is missing or not a positive integer");
  if (![pr.title, pr.url, pr.author].every((v) => typeof v === "string")) c.bad("title, url and author must be strings");
  else if (!isHttpsUrl(pr.url)) c.bad("url must be an https url");
  c.oneOf(pr, "role", REVIEW_ROLES, { required: true });
  c.oneOf(pr, "status", REVIEW_STATUSES, { required: true });
  c.oneOf(pr, "risk", REVIEW_RISKS);
  if (!isObj(pr.this_run) || !inEnum(REVIEW_ACTIONS, pr.this_run.action)) {
    c.bad("this_run.action must be approved, changes_requested, commented, replied, drafted or none");
  }
  if (isObj(pr.this_run)) {
    const run = new Checker(out, `${where}this_run.`);
    run.strings(pr.this_run, "changes", LIMITS.changes);
    run.str(pr.this_run, "summary");
    run.url(pr.this_run, "url");
  }
  if (has(pr, "needs_you")) {
    if (!isObj(pr.needs_you)) c.bad("needs_you must be an object or null");
    else {
      const ny = new Checker(out, `${where}needs_you.`);
      ny.str(pr.needs_you, "ask", { required: true });
      ny.strings(pr.needs_you, "facts", LIMITS.facts);
      ny.strings(pr.needs_you, "options", LIMITS.needsOptions);
    }
  }
  for (const k of ["base", "status_note", "impact"]) c.str(pr, k);
  c.time(pr, "created_at");
  c.time(pr, "updated_at");
  c.strings(pr, "tradeoffs", LIMITS.tradeoffs);
  c.strings(pr, "risks", LIMITS.risks);
  if (has(pr, "last_action")) {
    if (!isObj(pr.last_action)) c.bad("last_action must be an object or null");
    else {
      const la = new Checker(out, `${where}last_action.`);
      la.str(pr.last_action, "kind");
      la.time(pr.last_action, "at");
      la.url(pr.last_action, "url");
    }
  }
  if (has(pr, "threads")) {
    if (!isObj(pr.threads)) c.bad("threads must be an object or null");
    else {
      const t = new Checker(out, `${where}threads.`);
      if (has(pr.threads, "open") && !isNonNegInt(pr.threads.open)) t.bad("open must be a whole number");
      t.list(pr.threads, "items", LIMITS.threadItems, (x) => (isObj(x) ? null : "must be an object"));
    }
  }
  if (has(pr, "ci")) {
    if (!isObj(pr.ci)) c.bad("ci must be an object or null");
    else new Checker(out, `${where}ci.`).oneOf(pr.ci, "state", CI_STATES, { required: true });
  }
  c.list(pr, "reviewers", 100, (x) =>
    !isObj(x) || typeof x.login !== "string" ? "must be {login, state}" : inEnum(REVIEWER_STATES, x.state) ? null : `has unknown state ${show(x.state)}`,
  );
  c.list(pr, "assignees", 100, (x) => (typeof x === "string" ? null : "must be a string"));
  c.oneOf(pr, "mergeable", MERGEABLE);
  c.list(pr, "linear", 20, (x) => (isObj(x) && typeof x.id === "string" && isHttpUrl(x.url) ? null : "must be {id, url}"));
  c.links(pr, "links", LIMITS.links);
  const bytes = jsonBytes(pr);
  if (bytes > LIMITS.prBytes) c.bad(`the entry is ${bytes} bytes as JSON, over ${LIMITS.prBytes}`);
}

// --- Schema 2: asks and resolved -----------------------------------------------------------------------------

function askProblems(ask: unknown, i: number, prNumbers: Set<number>, keys: Set<string>, out: string[]): void {
  if (!isObj(ask)) {
    out.push(`asks[${i}] is not an object`);
    return;
  }
  const key = typeof ask.key === "string" ? ask.key : "";
  const c = new Checker(out, ASK_KEY_RE.test(key) ? `ask ${key}: ` : `asks[${i}]: `);
  if (!ASK_KEY_RE.test(key)) c.bad(`key must be "<pr>-<hold>", e.g. "4737-product"; got ${show(ask.key)}`);
  else if (keys.has(key)) c.bad("two asks share this key");
  keys.add(key);
  c.oneOf(ask, "type", ASK_TYPES, { required: true });
  c.oneOf(ask, "priority", PRIORITIES);
  c.str(ask, "title", { required: true, max: 300 });
  c.str(ask, "summary");
  c.str(ask, "question");
  c.str(ask, "context", { max: LIMITS.text });
  c.str(ask, "cost_of_waiting");
  c.links(ask, "links", LIMITS.links);

  const ids = new Set<string>();
  const opts = ask.options;
  if (!Array.isArray(opts) || opts.length < LIMITS.askOptionsMin || opts.length > LIMITS.askOptionsMax) {
    c.bad(`options must be a list of ${LIMITS.askOptionsMin}-${LIMITS.askOptionsMax} options`);
  }
  if (Array.isArray(opts)) {
    opts.forEach((o, j) => {
      const oc = new Checker(out, `${c.where}options[${j}] `);
      if (!isObj(o)) return oc.bad("must be {id, label}");
      if (typeof o.id !== "string" || !OPTION_ID_RE.test(o.id)) oc.bad(`id ${show(o.id)} is not a valid option id`);
      else if (o.id === "other") oc.bad('id "other" is every item\'s own: leave it out');
      else if (ids.has(o.id)) oc.bad(`id "${o.id}" is used twice`);
      if (typeof o.id === "string") ids.add(o.id);
      oc.str(o, "label", { required: true, max: 200 });
      oc.str(o, "consequence");
      if (has(o, "reversible") && typeof o.reversible !== "boolean") oc.bad("reversible must be true or false");
    });
  }
  if (has(ask, "recommendation")) {
    const r = ask.recommendation;
    if (!isObj(r)) c.bad("recommendation must be an object");
    else {
      const rc = new Checker(out, `${c.where}recommendation.`);
      if (typeof r.option !== "string" || !ids.has(r.option)) rc.bad(`option ${show(r.option)} is not one of the options`);
      rc.oneOf(r, "confidence", CONFIDENCES);
      rc.str(r, "why");
    }
  }
  const rv = ask.review;
  if (!isObj(rv)) return c.bad("review must be {pr, hold}");
  if (!isPosInt(rv.pr)) c.bad("review.pr must be a PR number");
  else if (!prNumbers.has(rv.pr)) c.bad(`review.pr #${rv.pr} is not in the report's prs`);
  if (!inEnum(HOLDS, rv.hold)) c.bad(`review.hold must be one of ${HOLDS.join(", ")}`);
  if (has(rv, "hold_review_id") && !isPosInt(rv.hold_review_id)) c.bad("review.hold_review_id must be a positive integer or null");
  if (has(rv, "pending_review_id") && !isPosInt(rv.pending_review_id)) c.bad("review.pending_review_id must be a positive integer");
  if (has(rv, "event") && !inEnum(REVIEW_EVENTS, rv.event)) c.bad(`review.event must be one of ${REVIEW_EVENTS.join(", ")}`);
  if (has(rv, "head_sha") && (typeof rv.head_sha !== "string" || !rv.head_sha)) c.bad("review.head_sha must be a non-empty string");
  // The routine's own copy of the draft, when it keeps drafts itself instead of as a pending review on GitHub.
  if (has(rv, "draft_id")) {
    if (rv.hold !== "post") c.bad("review.draft_id is only for a post ask");
    else if (typeof rv.draft_id !== "string" || !/^\S{1,100}$/.test(rv.draft_id)) c.bad("review.draft_id must be 1-100 characters with no spaces");
    else if (has(rv, "pending_review_id")) c.bad("review has both pending_review_id and draft_id; a draft is one or the other");
  }
  if (has(rv, "also")) {
    const also = rv.also;
    if (rv.hold !== "product") c.bad("review.also is only for a product call");
    else if (!Array.isArray(also)) c.bad("review.also must be a list of PR numbers");
    else if (also.length > LIMITS.also) c.bad(`review.also has ${also.length} PRs, at most ${LIMITS.also}`);
    else {
      const seenPr = new Set<number>();
      for (const n of also) {
        if (!isPosInt(n)) c.bad("review.also must be a list of PR numbers");
        else if (n === rv.pr) c.bad(`review.also #${n} is the ask's own PR`);
        else if (seenPr.has(n)) c.bad(`review.also lists #${n} twice`);
        else if (!prNumbers.has(n)) c.bad(`review.also #${n} is not in the report's prs`);
        if (isPosInt(n)) seenPr.add(n);
      }
    }
  }
  if (ASK_KEY_RE.test(key) && isPosInt(rv.pr) && inEnum(HOLDS, rv.hold) && key !== `${rv.pr}-${rv.hold}`) {
    c.bad(`key must be "<review.pr>-<review.hold>", "${rv.pr}-${rv.hold}"`);
  }
}

// An answer to a question asked on one of the routine's items; the runner posts it to that item's Q&A thread.
function answerProblems(a: unknown, i: number, ids: Set<string>, out: string[]): void {
  const c = new Checker(out, `answers[${i}]: `);
  if (!isObj(a)) return c.bad("must be {id, text}");
  if (typeof a.id !== "string" || !ITEM_ID_RE.test(a.id)) c.bad(`id ${show(a.id)} is not an item id`);
  else if (ids.has(a.id)) c.bad(`id "${a.id}" is answered twice`);
  if (typeof a.id === "string") ids.add(a.id);
  if (typeof a.text !== "string" || !a.text.trim() || a.text.length > LIMITS.answer) c.bad(`text must be 1-${LIMITS.answer} characters`);
}

function resolvedProblems(r: unknown, i: number, ids: Set<string>, out: string[]): void {
  const c = new Checker(out, `resolved[${i}]: `);
  if (!isObj(r)) return c.bad("must be {id, version, pr, review_url}");
  if (typeof r.id !== "string" || !ITEM_ID_RE.test(r.id)) c.bad(`id ${show(r.id)} is not an item id`);
  else if (ids.has(r.id)) c.bad(`id "${r.id}" is listed twice`);
  if (typeof r.id === "string") ids.add(r.id);
  if (!isPosInt(r.version)) c.bad("version must be the item's version, a positive integer");
  if (!isPosInt(r.pr)) c.bad("pr must be a PR number");
  c.url(r, "review_url");
}

// --- The report ----------------------------------------------------------------------------------------------

// Every problem with a report (docs/reviews.md "The report"), [] when it is valid.
export function reportProblems(report: unknown): string[] {
  if (!isObj(report)) return ["the top level is not an object"];
  if (!Array.isArray(report.prs)) return ["prs is missing or not an array"];
  const out: string[] = [];
  // Schema 1 reports predate the field, so a report without one is schema 1.
  const schema = report.schema ?? 1;
  if (!inEnum(SCHEMAS, schema)) out.push(`unknown schema ${show(report.schema)}: this server reads ${SCHEMAS.join(" and ")}`);

  const top = new Checker(out, "");
  top.str(report, "headline");
  top.strings(report, "unverified", LIMITS.unverified);
  top.strings(report, "notes", LIMITS.notes);
  if (has(report, "skipped")) {
    const skipped = report.skipped;
    if (!isObj(skipped)) out.push("skipped must be an object of PR number lists");
    else {
      const sk = new Checker(out, "skipped.");
      for (const k of Object.keys(skipped)) sk.list(skipped, k, LIMITS.skipped, (x) => (isPosInt(x) ? null : "must be a PR number"));
    }
  }

  const prs = report.prs;
  if (prs.length > LIMITS.prs) out.push(`prs has ${prs.length} entries, at most ${LIMITS.prs}`);
  const numbers = prs.filter(isObj).map((p) => p.number);
  if (new Set(numbers).size !== numbers.length) out.push("two entries share a PR number");
  prs.forEach((pr, i) => prProblems(pr, i, out));

  // Required with schema 2; a schema 1 report may carry them too, checked the same way.
  const prNumbers = new Set(numbers.filter(isPosInt));
  for (const k of ["asks", "resolved"] as const) {
    const v = report[k];
    if (v === undefined || v === null) {
      if (schema === 2) out.push(`${k} is required with schema 2 (an empty list when there are none)`);
      continue;
    }
    if (!Array.isArray(v)) {
      out.push(`${k} must be a list`);
      continue;
    }
    const max = k === "asks" ? LIMITS.asks : LIMITS.resolved;
    if (v.length > max) out.push(`${k} has ${v.length} entries, at most ${max}`);
    const seen = new Set<string>();
    if (k === "asks") v.forEach((a, i) => askProblems(a, i, prNumbers, seen, out));
    else v.forEach((r, i) => resolvedProblems(r, i, seen, out));
  }
  // Optional in any schema: answers to questions asked on the routine's items.
  if (has(report, "answers") && report.answers !== null) {
    const v = report.answers;
    if (!Array.isArray(v)) out.push("answers must be a list");
    else {
      if (v.length > LIMITS.answers) out.push(`answers has ${v.length} entries, at most ${LIMITS.answers}`);
      const seen = new Set<string>();
      v.forEach((a, i) => answerProblems(a, i, seen, out));
    }
  }
  return out;
}

// --- Request bodies ------------------------------------------------------------------------------------------

// The stamp's own time, "2026-10-08T180000Z" → "2026-10-08T18:00:00.000Z"; null when it isn't a real time.
export function stampTime(stamp: string): string | null {
  if (!STAMP_RE.test(stamp)) return null;
  const iso = `${stamp.slice(0, 13)}:${stamp.slice(13, 15)}:${stamp.slice(15, 17)}Z`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const out = new Date(t).toISOString();
  // Refuse what doesn't round-trip (2026-02-30, 25:00).
  return out.slice(0, 19) === iso.slice(0, 19) ? out : null;
}

export function stampProblems(stamp: unknown): string[] {
  return typeof stamp === "string" && stampTime(stamp) ? [] : [`stamp must be a UTC stamp like "2026-10-08T180000Z"; got ${show(stamp)}`];
}

function runFieldProblems(body: Obj, out: string[]): void {
  const c = new Checker(out, "");
  c.time(body, "started_at");
  c.time(body, "next_run_at");
  c.str(body, "log", { max: LIMITS.log });
  c.str(body, "model", { max: 100 });
  if (has(body, "dry") && typeof body.dry !== "boolean") c.bad("dry must be true or false");
}

// POST /api/reviews/runs/:stamp/start: the stamp from the path, and the body.
export function startPayloadProblems(stamp: unknown, body: unknown): string[] {
  const out = stampProblems(stamp);
  if (!isObj(body)) return [...out, "the body must be an object"];
  runFieldProblems(body, out);
  return out;
}

// POST /api/reviews/report's body, the report included.
export function reportPayloadProblems(body: unknown): string[] {
  if (!isObj(body)) return ["the body must be an object"];
  const out = stampProblems(body.stamp);
  const c = new Checker(out, "");
  runFieldProblems(body, out);
  c.time(body, "finished_at");
  c.oneOf(body, "result", FINISHED_RESULTS, { required: true });
  if (has(body, "exit") && !Number.isSafeInteger(body.exit)) c.bad("exit must be an integer or null");
  c.str(body, "error", { max: LIMITS.text });
  c.str(body, "notify");
  const report = body.report ?? null;
  if ((body.result === "ok" || body.result === "seed") && report === null) c.bad(`a ${body.result} run needs its report`);
  if (body.result === "report_invalid" && report !== null) c.bad("a report_invalid run has no report: send report: null");
  if (report !== null) out.push(...reportProblems(report).map((p) => `report: ${p}`));
  return out;
}

// --- Run requests (docs/reviews.md "Run requests") -------------------------------------------------------------

export const RUN_REQUEST_UPDATES = ["starting", "started", "skipped", "failed"] as const satisfies readonly ReviewRunRequestUpdate["status"][];
// A request the poller hasn't started within this long (still requested, or picked up and waiting for memory or the
// routine's lock) no longer holds the Run button: the runner or its poller is down, and a new request replaces it.
export const RUN_REQUEST_STALE_MS = 30 * 60_000;
// A run still `running` this long after it started no longer holds the button either: its runner died. A run takes
// should finish (and report) well within this, retries included.
export const RUN_STALE_MS = 4 * 3_600_000;

// POST /api/reviews/run-requests/:id body.
export function runRequestUpdateProblems(body: unknown): string[] {
  if (!isObj(body)) return ["the body must be an object"];
  const out: string[] = [];
  const c = new Checker(out, "");
  c.oneOf(body, "status", RUN_REQUEST_UPDATES, { required: true });
  if (body.status === "started") out.push(...stampProblems(body.stamp));
  else if (has(body, "stamp")) c.bad("only a started request names its run's stamp");
  c.str(body, "message", { max: 500 });
  return out;
}

// The run that holds the routine, if any: started after its newest finished run, less than RUN_STALE_MS ago.
export function liveRun<R extends { stamp: string; result: string; started_at: string }>(runs: R[], lastStamp: string | null, now: number): R | null {
  return runs.find((r) => r.result === "running" && r.stamp > (lastStamp ?? "") && now - Date.parse(r.started_at) < RUN_STALE_MS) ?? null;
}

// Whether a request still waits on the poller (requested, or picked up and starting) and isn't stale yet. A started
// request holds the button through its run instead (liveRun).
export function requestPending(req: ReviewRunRequest | null, now: number): boolean {
  return !!req && (req.status === "requested" || req.status === "starting") && now - Date.parse(req.updated_at) < RUN_REQUEST_STALE_MS;
}
