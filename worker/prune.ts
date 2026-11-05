import type { Env } from "./env.ts";
import { dropDisallowed } from "./hooks/webpush.ts";

// Change log pruning, run by the daily Cron Trigger (wrangler.jsonc
// `triggers.crons`). The feed behind /api/changes only means "something
// changed, refetch state", so old rows have no reader once every client has
// moved past them.

const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
// Rows per DELETE, and DELETEs per run: one run touches at most 5,000 rows,
// well inside D1's per-invocation query and daily write allowances. A larger
// backlog drains over the following days.
const BATCH = 500;
const MAX_BATCHES = 10;

// A whole number of days, at least `min`. Anything else throws, so the cron
// run fails visibly instead of pruning a different window.
function daysSetting(name: string, raw: string | undefined, def: number, min: number): number {
  if (raw === undefined) return def;
  const s = raw.trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || n < min) {
    throw new Error(`${name} must be a whole number of days, at least ${min}; got "${raw}"`);
  }
  return n;
}

// CHANGES_RETENTION_DAYS: default 30, at least 7.
export function retentionDays(raw: string | undefined): number {
  return daysSetting("CHANGES_RETENTION_DAYS", raw, DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS);
}

// Delete changes with `at` before `cutoff` (ISO 8601, the format every `at`
// is written in), oldest first, `batch` rows per statement and at most
// `maxBatches` statements. The newest change is never deleted, so
// max(seq), which /api/changes and /api/state report as the cursor, never
// goes backwards; seq itself is AUTOINCREMENT and never reused.
export async function pruneChanges(
  db: D1Database,
  opts: { cutoff: string; batch: number; maxBatches: number },
): Promise<{ deleted: number; done: boolean }> {
  const stmt = db
    .prepare(
      `DELETE FROM changes WHERE seq IN (
         SELECT seq FROM changes
         WHERE at < ?1 AND seq < (SELECT max(seq) FROM changes)
         ORDER BY seq LIMIT ?2)`,
    )
    .bind(opts.cutoff, opts.batch);
  let deleted = 0;
  for (let i = 0; i < opts.maxBatches; i++) {
    const n = (await stmt.run()).meta.changes;
    deleted += n;
    if (n < opts.batch) return { deleted, done: true };
  }
  return { deleted, done: false };
}

export async function pruneOnSchedule(db: D1Database, scheduledTime: number, raw: string | undefined) {
  const days = retentionDays(raw);
  const cutoff = new Date(scheduledTime - days * DAY_MS).toISOString();
  const r = await pruneChanges(db, { cutoff, batch: BATCH, maxBatches: MAX_BATCHES });
  console.log(
    `pruned ${r.deleted} changes older than ${days} days (before ${cutoff})` +
      (r.done ? "" : "; more remain for the next run"),
  );
  return r;
}

// Snoozes (migration 0007) that are spent: their time has passed, or their
// item is no longer open (decided, archived, gone). /api/state already skips
// past ones, so this only keeps the table small. Each delete logs a change
// only the snoozer's own feed shows.
export async function pruneSnoozes(db: D1Database, scheduledTime: number): Promise<number> {
  const now = new Date(scheduledTime).toISOString();
  const r = await db
    .prepare(
      `DELETE FROM snoozes WHERE until <= ?1 OR NOT EXISTS
         (SELECT 1 FROM docs WHERE collection = 'items' AND id = snoozes.item_id AND status = 'open')`,
    )
    .bind(now)
    .run();
  console.log(`pruned ${r.meta.changes} spent snoozes`);
  return r.meta.changes;
}

// Pins (migration 0010) on things that are gone: an item or orchestrator
// deleted without the routes' cleanup (a Worker from before pins), or a PR
// pruneReviews dropped (run after it). The page already skips them; this only
// keeps the table small. Each delete logs a change only the pinner's own feed
// shows.
export async function prunePins(db: D1Database): Promise<number> {
  const r = await db
    .prepare(
      `DELETE FROM pins WHERE
         (kind = 'item' AND NOT EXISTS (SELECT 1 FROM docs WHERE collection = 'items' AND id = pins.ref))
         OR (kind = 'orch' AND NOT EXISTS (SELECT 1 FROM docs WHERE collection = 'orchestrators' AND id = pins.ref))
         OR (kind = 'pr' AND NOT EXISTS (SELECT 1 FROM review_prs AS p WHERE p.routine || '/' || p.number = pins.ref))
         OR kind NOT IN ('item', 'orch', 'pr')`,
    )
    .run();
  console.log(`pruned ${r.meta.changes} pins on things that are gone`);
  return r.meta.changes;
}

// Web Push subscriptions whose endpoint no longer passes the endpoint rule
// (stored before the allowlist, or under a PUSH_ENDPOINT_HOSTS entry since
// removed). Every send already skips and deletes them; this catches the ones
// no send reaches. A small table, checked in the Worker; nothing is pushed.
export async function prunePushSubscriptions(env: Env): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, endpoint FROM push_subscriptions").all<{ id: number; endpoint: string }>();
  const { removed } = await dropDisallowed(env, results);
  console.log(`pruned ${removed} push subscriptions on hosts that aren't allowed push services`);
  return removed;
}

// --- Reviews (migration 0009, docs/reviews.md "Retention") -----------------

export const DEFAULT_REVIEWS_RETENTION_DAYS = 90;
const MIN_REVIEWS_RETENTION_DAYS = 14;
// A PR that dropped out of the newest report (merged, closed, stale) goes this
// long after it did. The tab stops showing it after 7.
export const GONE_PR_DAYS = 30;

// REVIEWS_RETENTION_DAYS: default 90, at least 14.
export function reviewsRetentionDays(raw: string | undefined): number {
  return daysSetting("REVIEWS_RETENTION_DAYS", raw, DEFAULT_REVIEWS_RETENTION_DAYS, MIN_REVIEWS_RETENTION_DAYS);
}

// An ISO time as a run stamp ("2026-10-08T18:00:00.000Z" → "2026-10-08T180000Z"),
// so it compares with stamps as strings.
export const toStamp = (iso: string) => iso.slice(0, 19).replace(/:/g, "") + "Z";

// Runs and events older than the retention, and PRs gone for GONE_PR_DAYS.
// Each routine keeps three runs (with their events) whatever their age: its
// newest; its head's last_stamp run, which /api/state's `routines` reads, so
// that never changes here and this logs no change rows; and its newest run
// with a report, the watermark that keeps a late retry of an older run from
// bringing back a PR the newest report dropped (worker/reviews.ts
// NEWEST_REPORT). docs/reviews.md "Retention".
// One routine writes about 4 runs a day, so a daily run deletes a handful of
// rows; no batching is needed.
export async function pruneReviews(db: D1Database, scheduledTime: number, raw: string | undefined) {
  const days = reviewsRetentionDays(raw);
  const cutoff = toStamp(new Date(scheduledTime - days * DAY_MS).toISOString());
  const goneBefore = new Date(scheduledTime - GONE_PR_DAYS * DAY_MS).toISOString();
  // Is (routine, stamp) one a routine keeps? Events go first: this reads the runs before they are pruned.
  // IS, not =, where the subquery can be NULL (no report yet, no finished run): NOT (... OR NULL) keeps all.
  const kept = (t: string) => `(${t}.stamp = (SELECT max(stamp) FROM review_runs AS k WHERE k.routine = ${t}.routine)
    OR ${t}.stamp IS (SELECT max(stamp) FROM review_runs AS k WHERE k.routine = ${t}.routine AND k.has_report = 1)
    OR ${t}.stamp IS (SELECT last_stamp FROM review_routines AS h WHERE h.routine = ${t}.routine))`;
  const [events, runs, prs] = await db.batch([
    db.prepare(`DELETE FROM review_events WHERE stamp < ?1 AND NOT ${kept("review_events")}`).bind(cutoff),
    db.prepare(`DELETE FROM review_runs WHERE stamp < ?1 AND NOT ${kept("review_runs")}`).bind(cutoff),
    db.prepare("DELETE FROM review_prs WHERE gone_at IS NOT NULL AND gone_at < ?1").bind(goneBefore),
  ]);
  const r = { runs: runs.meta.changes, events: events.meta.changes, prs: prs.meta.changes };
  console.log(`pruned ${r.runs} review runs and ${r.events} events older than ${days} days, and ${r.prs} PRs gone over ${GONE_PR_DAYS} days`);
  return r;
}
