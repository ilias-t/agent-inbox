// /api/reviews: a review routine's runs, PRs and events (docs/reviews.md). The routine is always the writing
// token's orchestrator id: only that token starts and reports its runs, and nothing in a body or path names
// the routine it writes. Every human and the manager read every routine; an orchestrator token reads its own.
// A routine belongs to the fleet of the token that first wrote it (docs/api.md "Fleets"): a token of another
// fleet neither reads nor writes it. Admins can delete a routine (a dry-run one, typically).

import {
  reportPayloadProblems,
  RUN_REQUEST_STALE_MS,
  RUN_STALE_MS,
  runRequestUpdateProblems,
  STAMP_RE,
  startPayloadProblems,
} from "../../shared/reviews.ts";
import type {
  ReviewDeleteResponse,
  ReviewEvent,
  ReviewPrResponse,
  ReviewReportPayload,
  ReviewReportResponse,
  ReviewRoutineSummary,
  ReviewRunRequest,
  ReviewRunRequestResponse,
  ReviewRunRequestUpdate,
  ReviewsResponse,
  ReviewStartPayload,
  RoutineReviewsResponse,
} from "../../shared/types.ts";
import { fleetScope, orchestratorScope, requireAdmin, requireHuman, requireRole, type Caller } from "../auth.ts";
import { badRequest, conflict, forbidden, json, notFound, readJson } from "../http.ts";
import {
  bodySha,
  HEAD_COLS,
  PR_COLS,
  RUN_COLS,
  REVIEWS_BODY_LIMIT,
  reportStatements,
  startStatements,
  toHead,
  toPr,
  toRun,
  type HeadRow,
  type PrRow,
  type RunRow,
} from "../reviews.ts";
import type { Ctx, Route } from "../router.ts";

// How many problems a 400 names; the rest are the same kind, and the runner logs the message.
const SHOWN_PROBLEMS = 5;
const RUNS_PAGE = 30;
const RUNS_MAX = 100;
const EVENTS_PAGE = 50;
// Gone PRs stay in GET /reviews/:routine this long, so the tab can show what just merged.
const GONE_SHOWN_MS = 7 * 86_400_000;

function invalid(problems: string[]): never {
  const more = problems.length > SHOWN_PROBLEMS ? ` (and ${problems.length - SHOWN_PROBLEMS} more)` : "";
  throw badRequest(`${problems.slice(0, SHOWN_PROBLEMS).join("; ")}${more}`);
}

// The routine a write is for: the token's own orchestrator id. Humans and the manager never write runs.
function writer(caller: Caller): string {
  const routine = orchestratorScope(caller);
  if (routine === null) throw forbidden("Only a routine's own orchestrator token writes its reviews");
  return routine;
}

// Humans and the manager read every routine; an orchestrator token only its own (and only in its own fleet:
// each read checks the routine's fleet with routineFleet in the same batch as the data, so a routine another
// fleet creates meanwhile can't slip in between).
function requireReader(caller: Caller, routine: string): void {
  const scope = orchestratorScope(caller);
  if (scope !== null && scope !== routine) throw forbidden("Not this token's routine");
}

// A token reads and writes only a routine of its own fleet (docs/api.md "Fleets"); one nobody has written yet is
// anyone's to create. `row` is the routine's fleet as read with the data (undefined: no routine).
const routineFleetSql = (db: D1Database, routine: string) => db.prepare("SELECT fleet FROM review_routines WHERE routine = ?").bind(routine);
function checkRoutineFleet(caller: Caller, row: { fleet: string | null } | undefined): void {
  const fleet = fleetScope(caller);
  if (fleet !== undefined && row && row.fleet !== fleet) throw forbidden("Routine belongs to another fleet");
}

// A write's batch opens with this: it fails (NOT NULL on the routine), and so rolls the whole batch back, when the
// routine belongs to another fleet than the writer's. Checked in the write's own transaction, so two fleets'
// tokens racing to create one routine can't both land.
const fleetGuard = (db: D1Database, routine: string, fleet: string | null) =>
  db
    .prepare(
      `INSERT INTO review_routines (routine, version, updated_at) SELECT NULL, 0, ''
       WHERE EXISTS (SELECT 1 FROM review_routines WHERE routine = ?1 AND fleet IS NOT ?2)`,
    )
    .bind(routine, fleet);

// A run as stored, read with its routine's fleet and checked against the caller's (the routine may have been
// deleted and created again by another fleet since the caller's own write). Null when there is none.
async function runInFleet(c: Ctx, routine: string, stamp: string): Promise<RunRow | null> {
  const db = c.env.DB;
  const [fleet, run] = await db.batch<any>([routineFleetSql(db, routine), db.prepare(`SELECT ${RUN_COLS} FROM review_runs WHERE routine = ? AND stamp = ?`).bind(routine, stamp)]);
  checkRoutineFleet(c.caller, fleet.results[0]);
  return (run.results[0] as RunRow | undefined) ?? null;
}

// A write's statements behind fleetGuard, their results without its. When the batch fails, the routine's fleet
// says whether the guard tripped (403) or something else did (rethrown).
async function guardedBatch<T>(c: Ctx, routine: string, stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
  const db = c.env.DB;
  try {
    return (await db.batch<T>([fleetGuard(db, routine, fleetScope(c.caller) ?? null), ...stmts])).slice(1);
  } catch (e) {
    checkRoutineFleet(c.caller, (await routineFleetSql(db, routine).first<{ fleet: string | null }>()) ?? undefined);
    throw e;
  }
}

async function start(c: Ctx): Promise<Response> {
  const routine = writer(c.caller);
  const stamp = c.params.stamp;
  const body = await c.body();
  const problems = startPayloadProblems(stamp, body);
  if (problems.length) invalid(problems);
  const db = c.env.DB;
  const stmts = startStatements(db, { routine, actor: c.caller.actor, now: c.now, fleet: fleetScope(c.caller) ?? null, stamp, body: body as ReviewStartPayload });
  const results = await guardedBatch<RunRow>(c, routine, stmts);
  const row = results[results.length - 1].results[0];
  if (row) return json(toRun(row), 201);
  // Already there (a retried start, or one that arrived after its report): as stored, nothing written.
  const cur = await runInFleet(c, routine, stamp);
  if (!cur) throw new Error(`start of ${routine}/${stamp} wrote nothing and found no run`);
  return json(toRun(cur));
}

async function report(c: Ctx): Promise<Response> {
  const routine = writer(c.caller);
  const body = await readJson(c.request, REVIEWS_BODY_LIMIT);
  const problems = reportPayloadProblems(body);
  if (problems.length) invalid(problems);
  const payload = body as unknown as ReviewReportPayload;
  const sha = await bodySha(body);
  const db = c.env.DB;
  const stmts = reportStatements(db, { routine, actor: c.caller.actor, now: c.now, fleet: fleetScope(c.caller) ?? null, sha, payload });
  const results = await guardedBatch<RunRow>(c, routine, stmts);
  const row = results[results.length - 1].results[0];
  if (row) {
    const n = (i: number) => (payload.report ? results[i].meta.changes : 0);
    return json({ run: toRun(row), prs_written: n(1), events_written: n(3), gone: n(2) } satisfies ReviewReportResponse, 201);
  }
  // The run was already finished, so no statement wrote anything: a replay of the same body, or a conflict.
  const cur = await runInFleet(c, routine, payload.stamp);
  if (!cur) throw new Error(`report of ${routine}/${payload.stamp} wrote nothing and found no run`);
  if (cur.report_sha === sha) {
    return json({ run: toRun(cur), prs_written: 0, events_written: 0, gone: 0, replayed: true } satisfies ReviewReportResponse);
  }
  throw conflict("conflict", `Run ${payload.stamp} is already stored (${cur.result}) with a different report`, toRun(cur));
}

async function list(c: Ctx): Promise<Response> {
  const db = c.env.DB;
  const scope = orchestratorScope(c.caller) ?? "";
  // A token's own fleet's routines (?2); every one for a human.
  const fleet = fleetScope(c.caller);
  const binds = fleet === undefined ? [scope] : [scope, fleet];
  const inFleet = fleet === undefined ? "" : " AND routine IN (SELECT routine FROM review_routines WHERE fleet IS ?2)";
  const own = `(?1 = '' OR routine = ?1)${inFleet}`;
  const [heads, last, running, counts] = await db.batch<any>([
    db.prepare(`SELECT ${HEAD_COLS} FROM review_routines WHERE ${own} ORDER BY routine`).bind(...binds),
    db
      .prepare(
        `SELECT r.routine, r.stamp, r.result, r.finished_at, json_extract(r.data, '$.headline') AS headline
         FROM review_routines AS h JOIN review_runs AS r ON r.routine = h.routine AND r.stamp = h.last_stamp
         WHERE (?1 = '' OR h.routine = ?1)${fleet === undefined ? "" : " AND h.fleet IS ?2"}`,
      )
      .bind(...binds),
    // A run started after the newest finished one; the newest such per routine.
    db
      .prepare(
        `SELECT r.routine, max(r.stamp) AS stamp, r.started_at FROM review_runs AS r JOIN review_routines AS h ON h.routine = r.routine
         WHERE r.result = 'running' AND r.stamp > coalesce(h.last_stamp, '') AND (?1 = '' OR h.routine = ?1)${fleet === undefined ? "" : " AND h.fleet IS ?2"}
         GROUP BY r.routine`,
      )
      .bind(...binds),
    db
      .prepare(`SELECT routine, status, count(*) AS n, sum(needs_you) AS ny FROM review_prs WHERE gone_at IS NULL AND ${own} GROUP BY routine, status`)
      .bind(...binds),
  ]);
  const routines = (heads.results as HeadRow[]).map((h): ReviewRoutineSummary => {
    const l = last.results.find((r: { routine: string }) => r.routine === h.routine);
    const run = running.results.find((r: { routine: string }) => r.routine === h.routine);
    const mine = counts.results.filter((r: { routine: string }) => r.routine === h.routine) as { status: string; n: number; ny: number }[];
    return {
      routine: h.routine,
      version: h.version,
      last_run: l ? { stamp: l.stamp, result: l.result, finished_at: l.finished_at, headline: l.headline ?? null } : null,
      next_run_at: h.next_run_at,
      counts: Object.fromEntries(mine.map((r) => [r.status, r.n])),
      needs_you: mine.reduce((sum, r) => sum + r.ny, 0),
      running: run ? { stamp: run.stamp, started_at: run.started_at } : null,
    };
  });
  return json({ routines } satisfies ReviewsResponse);
}

function pageParams(c: Ctx): { before: string; limit: number } {
  const q = c.url.searchParams;
  const before = q.get("before") ?? "";
  if (before && !STAMP_RE.test(before)) throw badRequest('before must be a run stamp like "2026-10-08T180000Z"');
  const raw = q.get("limit");
  const limit = raw === null ? RUNS_PAGE : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUNS_MAX) throw badRequest(`limit must be an integer from 1 to ${RUNS_MAX}`);
  return { before, limit };
}

async function routineView(c: Ctx): Promise<Response> {
  const routine = c.params.routine;
  requireReader(c.caller, routine);
  const { before, limit } = pageParams(c);
  const db = c.env.DB;
  const goneSince = new Date(Date.parse(c.now) - GONE_SHOWN_MS).toISOString();
  const [fleet, head, prs, runs] = await db.batch<any>([
    routineFleetSql(db, routine),
    db.prepare(`SELECT ${HEAD_COLS} FROM review_routines WHERE routine = ?`).bind(routine),
    db
      .prepare(`SELECT ${PR_COLS} FROM review_prs WHERE routine = ? AND (gone_at IS NULL OR gone_at > ?) ORDER BY number DESC`)
      .bind(routine, goneSince),
    db
      .prepare(
        `SELECT routine, stamp, started_at, finished_at, result, dry, has_report, report_sha, data FROM review_runs
         WHERE routine = ?1 AND (?2 = '' OR stamp < ?2) ORDER BY stamp DESC LIMIT ?3`,
      )
      .bind(routine, before, limit + 1),
  ]);
  checkRoutineFleet(c.caller, fleet.results[0]);
  const h = head.results[0] as HeadRow | undefined;
  if (!h) throw notFound(`No reviews for ${routine}`);
  const page = (runs.results as RunRow[]).slice(0, limit);
  return json({
    routine: toHead(h),
    prs: (prs.results as PrRow[]).map(toPr),
    runs: page.map(toRun),
    more: runs.results.length > limit,
  } satisfies RoutineReviewsResponse);
}

async function prView(c: Ctx): Promise<Response> {
  const routine = c.params.routine;
  requireReader(c.caller, routine);
  const n = Number(c.params.n);
  if (!/^\d{1,9}$/.test(c.params.n) || n < 1) throw badRequest("The PR number must be a positive integer");
  const db = c.env.DB;
  const [fleet, pr, events] = await db.batch<any>([
    routineFleetSql(db, routine),
    db.prepare(`SELECT ${PR_COLS} FROM review_prs WHERE routine = ? AND number = ?`).bind(routine, n),
    db
      .prepare(`SELECT routine, number, stamp, data FROM review_events WHERE routine = ? AND number = ? ORDER BY stamp DESC LIMIT ${EVENTS_PAGE}`)
      .bind(routine, n),
  ]);
  checkRoutineFleet(c.caller, fleet.results[0]);
  const row = pr.results[0] as PrRow | undefined;
  if (!row) throw notFound(`${routine} doesn't track #${n}`);
  return json({
    pr: toPr(row),
    events: events.results.map((e: Omit<ReviewEvent, "data"> & { data: string }) => ({ ...e, data: JSON.parse(e.data) })),
  } satisfies ReviewPrResponse);
}

async function runView(c: Ctx): Promise<Response> {
  const { routine, stamp } = c.params;
  requireReader(c.caller, routine);
  if (!STAMP_RE.test(stamp)) throw badRequest('The stamp must look like "2026-10-08T180000Z"');
  const db = c.env.DB;
  const row = await runInFleet(c, routine, stamp);
  if (!row) throw notFound(`No run ${routine}/${stamp}`);
  return json(toRun(row));
}

// Everything the routine wrote, in one transaction. The head goes last, so its delete trigger logs the
// write's one change row.
async function del(c: Ctx): Promise<Response> {
  requireAdmin(c.caller);
  const routine = c.params.routine;
  const db = c.env.DB;
  const [events, prs, runs, head] = await db.batch([
    db.prepare("DELETE FROM review_events WHERE routine = ?").bind(routine),
    db.prepare("DELETE FROM review_prs WHERE routine = ?").bind(routine),
    db.prepare("DELETE FROM review_runs WHERE routine = ?").bind(routine),
    db.prepare("DELETE FROM review_routines WHERE routine = ?").bind(routine),
  ]);
  if (!head.meta.changes && !runs.meta.changes && !prs.meta.changes && !events.meta.changes) throw notFound(`No reviews for ${routine}`);
  return json({ ok: true, runs: runs.meta.changes, prs: prs.meta.changes, events: events.meta.changes } satisfies ReviewDeleteResponse);
}

// --- Run requests (docs/reviews.md "Run requests") ------------------------------------------------------------
// The Run button asks the routine's poller for one run. The request lives on the head row, so each write
// bumps the head and its trigger logs the write's one change row, which the open tab refetches on.

// ?1 the routine. A request still waiting on the poller (?5: updated after this), or a run holding the routine
// (?6: started after this), keeps a new request out, so a click starts at most one run.
const REQUEST_PENDING = `(run_request IS NOT NULL AND json_extract(run_request, '$.status') IN ('requested', 'starting')
  AND json_extract(run_request, '$.updated_at') > ?5)`;
const RUN_LIVE = `EXISTS (SELECT 1 FROM review_runs AS r WHERE r.routine = ?1 AND r.result = 'running'
  AND r.stamp > coalesce(review_routines.last_stamp, '') AND r.started_at > ?6)`;
// The statuses each update may come from: the poller picks a request up once, then starts, skips or fails it. A
// started request can still fail: its run exited before it got going (a failed git fetch), so it has no run.
const UPDATE_FROM: Record<ReviewRunRequestUpdate["status"], ReviewRunRequest["status"][]> = {
  starting: ["requested"],
  started: ["requested", "starting"],
  skipped: ["requested", "starting"],
  failed: ["requested", "starting", "started"],
};

const ago = (now: string, ms: number) => new Date(Date.parse(now) - ms).toISOString();
const headOf = (db: D1Database, routine: string) =>
  db.prepare(`SELECT ${HEAD_COLS}, fleet FROM review_routines WHERE routine = ?`).bind(routine).first<HeadRow & { fleet: string | null }>();

// Humans only, deciders and admins: no token can spend a routine's run on its own.
async function createRunRequest(c: Ctx): Promise<Response> {
  requireHuman(c.caller);
  requireRole(c.caller, "decider");
  const routine = c.params.routine;
  const p = c.caller.principal;
  const request: ReviewRunRequest = {
    id: `rq-${c.now.replace(/[-:]/g, "").slice(0, 15)}-${crypto.randomUUID().slice(0, 8)}`,
    status: "requested",
    requested_at: c.now,
    requested_by: p.kind === "human" ? p.email : "",
    updated_at: c.now,
    stamp: null,
    message: null,
  };
  const db = c.env.DB;
  const row = await db
    .prepare(
      `UPDATE review_routines SET version = version + 1, run_request = ?2, updated_at = ?3, updated_by = ?4
       WHERE routine = ?1 AND NOT ${REQUEST_PENDING} AND NOT ${RUN_LIVE}
       RETURNING routine`,
    )
    .bind(routine, JSON.stringify(request), c.now, c.caller.actor, ago(c.now, RUN_REQUEST_STALE_MS), ago(c.now, RUN_STALE_MS))
    .first();
  if (row) return json({ request } satisfies ReviewRunRequestResponse, 201);
  const [head, live] = await db.batch<any>([
    db.prepare(`SELECT ${HEAD_COLS} FROM review_routines WHERE routine = ?`).bind(routine),
    db
      .prepare(
        `SELECT r.stamp, r.started_at FROM review_runs AS r JOIN review_routines AS h ON h.routine = r.routine
         WHERE r.routine = ?1 AND r.result = 'running' AND r.stamp > coalesce(h.last_stamp, '') AND r.started_at > ?2
         ORDER BY r.stamp DESC LIMIT 1`,
      )
      .bind(routine, ago(c.now, RUN_STALE_MS)),
  ]);
  const h = head.results[0] as HeadRow | undefined;
  if (!h) throw notFound(`No reviews for ${routine}`);
  const run = live.results[0] as { stamp: string } | undefined;
  const current = toHead(h).run_request;
  throw conflict(
    "conflict",
    run ? `Run ${run.stamp} of ${routine} is still going` : `A run of ${routine} is already requested (${current?.status})`,
    { request: current },
  );
}

async function getRunRequest(c: Ctx): Promise<Response> {
  const routine = c.params.routine;
  requireReader(c.caller, routine);
  const h = await headOf(c.env.DB, routine);
  checkRoutineFleet(c.caller, h ?? undefined);
  if (!h) throw notFound(`No reviews for ${routine}`);
  return json({ request: toHead(h).run_request } satisfies ReviewRunRequestResponse);
}

// The routine's own token reports how its request went. A retry of the update it already made answers the request
// as stored; any other move is 409 with it, and a request another one replaced is 404.
async function updateRunRequest(c: Ctx): Promise<Response> {
  const routine = writer(c.caller);
  const id = c.params.id;
  const body = await c.body();
  const problems = runRequestUpdateProblems(body);
  if (problems.length) invalid(problems);
  const u = body as unknown as ReviewRunRequestUpdate;
  const db = c.env.DB;
  const row = await db
    .prepare(
      `UPDATE review_routines SET version = version + 1,
         run_request = json_set(run_request, '$.status', ?3, '$.updated_at', ?4, '$.stamp', ?5, '$.message', ?6),
         updated_at = ?4, updated_by = ?7
       WHERE routine = ?1 AND json_extract(run_request, '$.id') = ?2
         AND json_extract(run_request, '$.status') IN (SELECT value FROM json_each(?8)) AND fleet IS ?9
       RETURNING ${HEAD_COLS}`,
    )
    .bind(routine, id, u.status, c.now, u.stamp ?? null, u.message || null, c.caller.actor, JSON.stringify(UPDATE_FROM[u.status]), fleetScope(c.caller) ?? null)
    .first<HeadRow>();
  if (row) return json({ request: toHead(row).run_request } satisfies ReviewRunRequestResponse);
  const h = await headOf(db, routine);
  checkRoutineFleet(c.caller, h ?? undefined);
  const cur = h ? toHead(h).run_request : null;
  if (!cur || cur.id !== id) throw notFound(`No run request ${id} for ${routine}`);
  if (cur.status === u.status && (u.status !== "started" || cur.stamp === u.stamp)) {
    return json({ request: cur } satisfies ReviewRunRequestResponse);
  }
  throw conflict("conflict", `Run request ${id} is already ${cur.status}`, { request: cur });
}

// The fixed paths come first: the router takes the first pattern that matches.
export const reviewRoutes: Route[] = [
  ["POST", "/reviews/report", report],
  ["POST", "/reviews/runs/:stamp/start", start],
  ["POST", "/reviews/run-requests/:id", updateRunRequest],
  ["GET", "/reviews/:routine/run-request", getRunRequest],
  ["POST", "/reviews/:routine/run-request", createRunRequest],
  ["GET", "/reviews", list],
  ["GET", "/reviews/:routine", routineView],
  ["DELETE", "/reviews/:routine", del],
  ["GET", "/reviews/:routine/prs/:n", prView],
  ["GET", "/reviews/:routine/runs/:stamp", runView],
];
