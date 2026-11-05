// Review routines' storage (migration 0009, docs/reviews.md "Storage"). Every write to a routine goes through
// headBump in the same db.batch, and the head row's triggers are the routine's only change-log rows: one per
// write, however many PRs it carries. Report and start statements are each conditional on the same predicate,
// so a write the run's state refuses writes nothing at all (D1 doesn't roll a batch back for a statement that
// matched no row).

import type {
  ReviewEvent,
  ReviewPr,
  ReviewPrRow,
  ReviewReport,
  ReviewReportPayload,
  ReviewRoutineHead,
  ReviewRun,
  ReviewRunRecord,
  ReviewStartPayload,
} from "../shared/types.ts";
import { stampTime } from "../shared/reviews.ts";
import { sha256Hex } from "./http.ts";

export const REVIEWS_BODY_LIMIT = 1024 * 1024;

// The SQL predicates the write statements share; ?1 is the routine and ?2 the run's stamp in each.
// A report lands only while its run isn't finished (absent, or `running` from a start).
export const RUN_NOT_FINISHED = "NOT EXISTS (SELECT 1 FROM review_runs WHERE routine = ?1 AND stamp = ?2 AND result <> 'running')";
// A start lands only while its run doesn't exist yet.
export const RUN_ABSENT = "NOT EXISTS (SELECT 1 FROM review_runs WHERE routine = ?1 AND stamp = ?2)";
// The routine's newest stored report, '' before its first: the run that decides current PR state.
const NEWEST_REPORT = "(SELECT coalesce(max(stamp), '') FROM review_runs WHERE routine = ?1 AND has_report = 1)";

export interface HeadBump {
  routine: string;
  actor: string;
  now: string;
  stamp?: string; // ?2 for `when`
  lastStamp?: string | null; // a finished run's stamp: raises last_stamp when newer
  // Replaces next_run_at when given (null clears it: the routine has no schedule), but only from the newest run the
  // routine knows. Undefined keeps it.
  nextRunAt?: string | null;
  when?: string; // the write's predicate (RUN_NOT_FINISHED, RUN_ABSENT); always true when absent
}

// The head write every review write path makes: create the routine at version 1, or bump its version. Its
// trigger appends the write's one `changes` row (collection 'reviews', orchestrator = routine).
export function headBump(db: D1Database, h: HeadBump): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO review_routines (routine, version, last_stamp, next_run_at, updated_at, updated_by)
       SELECT ?1, 1, ?3, ?4, ?5, ?6 WHERE ${h.when ?? "1"}
       ON CONFLICT (routine) DO UPDATE SET
         version = review_routines.version + 1,
         last_stamp = CASE WHEN excluded.last_stamp IS NOT NULL
             AND (review_routines.last_stamp IS NULL OR excluded.last_stamp > review_routines.last_stamp)
           THEN excluded.last_stamp ELSE review_routines.last_stamp END,
         -- Only the newest run the routine knows (started or finished) moves next_run_at, so a late
         -- report or a retried start of an older run never sets it back. This runs before the run row
         -- is written in the same batch, so a report on its own running row compares equal.
         next_run_at = CASE WHEN ?7 = 1
             AND (?2 = '' OR ?2 >= (SELECT coalesce(max(stamp), '') FROM review_runs WHERE routine = ?1))
           THEN excluded.next_run_at ELSE review_routines.next_run_at END,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .bind(h.routine, h.stamp ?? "", h.lastStamp ?? null, h.nextRunAt ?? null, h.now, h.actor, h.nextRunAt === undefined ? 0 : 1);
}

// --- What a report stores ------------------------------------------------------------------------------------

// An optional ISO time, normalized like every time the Worker writes.
const isoOrNull = (v: unknown) => (typeof v === "string" && v ? new Date(v).toISOString() : null);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
// A body's next_run_at for headBump: left out keeps the head's, null clears it (the routine runs on demand only).
const nextRun = (v: unknown) => (v === undefined ? undefined : isoOrNull(v));

// The run record (docs/reviews.md "The run record"), built from the payload and its report.
export function runRecord(
  stamp: string,
  body: { started_at: string; finished_at: string | null; result: ReviewRun["result"] } & Partial<ReviewReportPayload>,
  report: ReviewReport | null,
): ReviewRunRecord {
  const prs = report?.prs ?? [];
  const counts: ReviewRunRecord["counts"] = {};
  for (const p of prs) counts[p.status] = (counts[p.status] ?? 0) + 1;
  return {
    stamp,
    started: body.started_at,
    finished: body.finished_at,
    dry: body.dry === true,
    result: body.result,
    exit: typeof body.exit === "number" ? body.exit : null,
    error: str(body.error),
    log: str(body.log),
    model: str(body.model),
    headline: str(report?.headline),
    notify: str(body.notify),
    schema: report ? (report.schema ?? 1) : null,
    counts,
    actions: prs
      .filter((p) => p.this_run.action !== "none")
      .map((p) => ({ pr: p.number, title: p.title, action: p.this_run.action, url: str(p.this_run.url), summary: str(p.this_run.summary) })),
    needs_you: prs.filter((p) => p.needs_you).map((p) => ({ pr: p.number, title: p.title, ask: p.needs_you!.ask })),
    unverified: report?.unverified ?? [],
    notes: report?.notes ?? [],
    skipped: report?.skipped ?? {},
    asks: report?.asks ?? [],
    resolved: report?.resolved ?? [],
  };
}

// Each PR with an action or changes this run: the run's events (docs/reviews.md "The run record").
export function runEvents(stamp: string, at: string, log: string | null, prs: ReviewPr[]): { n: number; data: ReviewEvent["data"] }[] {
  return prs
    .filter((p) => p.this_run.action !== "none" || (p.this_run.changes ?? []).length > 0)
    .map((p) => ({
      n: p.number,
      data: {
        pr: p.number,
        stamp,
        at,
        title: p.title,
        url: p.url,
        role: p.role,
        action: p.this_run.action,
        review_url: str(p.this_run.url),
        summary: str(p.this_run.summary),
        changes: p.this_run.changes ?? [],
        status: p.status,
        status_note: str(p.status_note),
        log,
      },
    }));
}

// JSON with object keys sorted at every level, so the same body hashes the same however its keys were ordered.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const bodySha = (body: unknown) => sha256Hex(canonicalJson(body));

const RUN_COLS = "routine, stamp, started_at, finished_at, result, dry, has_report, report_sha, data";

// The report's statements, in the order they must run: the head first, the run last (statements 2-4 read
// "is the run finished?" and the newest stored report, which the run row would change).
export function reportStatements(
  db: D1Database,
  w: { routine: string; actor: string; now: string; sha: string; payload: ReviewReportPayload },
): D1PreparedStatement[] {
  const { routine, actor, now, payload: p } = w;
  const stamp = p.stamp;
  const report = p.report ?? null;
  const started = p.started_at ? new Date(p.started_at).toISOString() : stampTime(stamp)!;
  const finished = p.finished_at ? new Date(p.finished_at).toISOString() : now;
  const record = runRecord(stamp, { ...p, started_at: started, finished_at: finished }, report);
  const stmts = [
    headBump(db, { routine, actor, now, stamp, lastStamp: stamp, nextRunAt: nextRun(p.next_run_at), when: RUN_NOT_FINISHED }),
  ];
  if (report) {
    const rows = report.prs.map((pr) => ({
      n: pr.number,
      url: pr.url.replace(/\/+$/, ""),
      role: pr.role,
      status: pr.status,
      ny: pr.needs_you ? 1 : 0,
      data: pr,
    }));
    // Each json_each element is read from its own `value`, under a CASE on its type (migration 0008's
    // rule): a path from the root would re-walk the array per element, and json_extract fails on a scalar.
    const col = (k: string) => `CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.${k}') END AS ${k}`;
    stmts.push(
      // 2. Every PR the report lists. A row moves only forward (a newer run than the one that wrote it), and
      // only the newest report decides whether a PR is current: an older report's rows go in already gone.
      db
        .prepare(
          `WITH j AS (SELECT ${["n", "url", "role", "status", "ny", "data"].map(col).join(", ")} FROM json_each(?4) AS e)
           INSERT INTO review_prs (routine, number, url, role, status, needs_you, data, last_stamp, gone_at, updated_at)
           SELECT ?1, n, url, role, status, ny, data, ?2, CASE WHEN ?2 < ${NEWEST_REPORT} THEN ?3 END, ?3
           FROM j WHERE n IS NOT NULL AND ${RUN_NOT_FINISHED}
           ON CONFLICT (routine, number) DO UPDATE SET
             url = excluded.url, role = excluded.role, status = excluded.status, needs_you = excluded.needs_you,
             data = excluded.data, last_stamp = excluded.last_stamp, updated_at = excluded.updated_at,
             gone_at = CASE WHEN excluded.gone_at IS NULL THEN NULL ELSE review_prs.gone_at END
           WHERE excluded.last_stamp > review_prs.last_stamp`,
        )
        .bind(routine, stamp, now, JSON.stringify(rows)),
      // 3. Current PRs the newest report no longer lists are gone (merged, closed, stale).
      db
        .prepare(
          `UPDATE review_prs SET gone_at = ?3, updated_at = ?3
           WHERE routine = ?1 AND gone_at IS NULL AND last_stamp < ?2
             AND number NOT IN (SELECT value FROM json_each(?4) WHERE type = 'integer')
             AND ?2 >= ${NEWEST_REPORT} AND ${RUN_NOT_FINISHED}`,
        )
        .bind(routine, stamp, now, JSON.stringify(rows.map((r) => r.n))),
      // 4. This run's events. A report that names no log takes its start's, as the run row does (statement 5).
      db
        .prepare(
          `WITH j AS (SELECT ${col("n")}, ${col("data")} FROM json_each(?3) AS e)
           INSERT INTO review_events (routine, number, stamp, data)
           SELECT ?1, n, ?2, json_set(data, '$.log', coalesce(json_extract(data, '$.log'),
               (SELECT json_extract(r.data, '$.log') FROM review_runs AS r WHERE r.routine = ?1 AND r.stamp = ?2)))
           FROM j WHERE n IS NOT NULL AND ${RUN_NOT_FINISHED}
           ON CONFLICT DO NOTHING`,
        )
        .bind(routine, stamp, JSON.stringify(runEvents(stamp, started, record.log, report.prs))),
    );
  }
  // 5. The run, last. A start's `model` and `log` survive a report that doesn't name them.
  stmts.push(
    db
      .prepare(
        `INSERT INTO review_runs (${RUN_COLS})
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${RUN_NOT_FINISHED}
         ON CONFLICT (routine, stamp) DO UPDATE SET
           started_at = excluded.started_at, finished_at = excluded.finished_at, result = excluded.result,
           dry = excluded.dry, has_report = excluded.has_report, report_sha = excluded.report_sha,
           data = json_set(excluded.data,
             '$.model', coalesce(json_extract(excluded.data, '$.model'), json_extract(review_runs.data, '$.model')),
             '$.log', coalesce(json_extract(excluded.data, '$.log'), json_extract(review_runs.data, '$.log')))
         WHERE review_runs.result = 'running'
         RETURNING ${RUN_COLS}`,
      )
      .bind(routine, stamp, started, finished, p.result, p.dry ? 1 : 0, report ? 1 : 0, w.sha, JSON.stringify(record)),
  );
  return stmts;
}

// A start's statements: the head, then the run as `running`, both only while the run doesn't exist.
export function startStatements(
  db: D1Database,
  w: { routine: string; actor: string; now: string; stamp: string; body: ReviewStartPayload },
): D1PreparedStatement[] {
  const { routine, actor, now, stamp, body } = w;
  const started = body.started_at ? new Date(body.started_at).toISOString() : stampTime(stamp)!;
  const record: Partial<ReviewRunRecord> = { stamp, started, finished: null, dry: body.dry === true, result: "running", log: str(body.log), model: str(body.model) };
  return [
    headBump(db, { routine, actor, now, stamp, nextRunAt: nextRun(body.next_run_at), when: RUN_ABSENT }),
    db
      .prepare(
        `INSERT INTO review_runs (${RUN_COLS})
         SELECT ?1, ?2, ?3, NULL, 'running', ?4, 0, NULL, ?5 WHERE ${RUN_ABSENT}
         ON CONFLICT DO NOTHING
         RETURNING ${RUN_COLS}`,
      )
      .bind(routine, stamp, started, body.dry ? 1 : 0, JSON.stringify(record)),
  ];
}

// --- Rows to wire types --------------------------------------------------------------------------------------

export interface RunRow {
  routine: string;
  stamp: string;
  started_at: string;
  finished_at: string | null;
  result: ReviewRun["result"];
  dry: number;
  has_report: number;
  report_sha: string | null;
  data: string;
}

export const toRun = (r: RunRow): ReviewRun => ({
  routine: r.routine,
  stamp: r.stamp,
  started_at: r.started_at,
  finished_at: r.finished_at,
  result: r.result,
  dry: !!r.dry,
  has_report: !!r.has_report,
  report_sha: r.report_sha,
  data: JSON.parse(r.data),
});

export const getRun = (db: D1Database, routine: string, stamp: string) =>
  db.prepare(`SELECT ${RUN_COLS} FROM review_runs WHERE routine = ? AND stamp = ?`).bind(routine, stamp).first<RunRow>();

export const PR_COLS = "routine, number, url, role, status, needs_you, data, last_stamp, gh, gone_at, updated_at";
export interface PrRow extends Omit<ReviewPrRow, "needs_you" | "data" | "gh"> {
  needs_you: number;
  data: string;
  gh: string | null;
}
export const toPr = (r: PrRow): ReviewPrRow => ({ ...r, needs_you: !!r.needs_you, data: JSON.parse(r.data), gh: r.gh ? JSON.parse(r.gh) : null });

export const HEAD_COLS = "routine, version, last_stamp, next_run_at, updated_at, updated_by, run_request";
export interface HeadRow extends Omit<ReviewRoutineHead, "run_request"> {
  run_request: string | null;
}
export const toHead = (r: HeadRow): ReviewRoutineHead => ({ ...r, run_request: r.run_request ? JSON.parse(r.run_request) : null });

// /api/state's `routines` and the delta's copy: every routine (or just `?2`'s, for an orchestrator token, when
// `scopeParam` names it), with its newest finished run.
export const routinesSql = (scopeParam: string) =>
  `SELECT h.routine AS id, h.version, r.finished_at AS last_run_at, r.result
   FROM review_routines AS h LEFT JOIN review_runs AS r ON r.routine = h.routine AND r.stamp = h.last_stamp
   WHERE (${scopeParam} = '' OR h.routine = ${scopeParam}) ORDER BY h.routine`;
