-- Reviews (docs/reviews.md): a review routine's runs, the current state of
-- each PR it tracks, and one event per PR per run that touched it. Written
-- by POST /api/reviews/report and /runs/:stamp/start, with the routine
-- always the writing token's orchestrator id.
--
-- Safe on live data: it only adds four new tables and their triggers and
-- indexes. Nothing on docs, users, snoozes or changes is altered, no existing
-- row is read or written, and nothing is logged. The Worker that is live
-- while this runs (deploy.yml migrates before it deploys), and one brought
-- back by `wrangler rollback`, never touch these tables; the change rows
-- they get later (collection 'reviews') are ones their /api/state/delta skips
-- as an unknown collection and their /api/changes passes on unfiltered.
--
-- Rolling back: DROP TABLE review_events, review_prs, review_runs,
-- review_routines (their triggers and indexes go with them).

-- One row per routine: the head every write bumps, and the routine's only
-- source of change-log rows (one per write, however many PRs it carries).
-- NOT NULL: a non-INTEGER primary key may otherwise hold NULL in SQLite.
CREATE TABLE review_routines (
  routine     TEXT NOT NULL PRIMARY KEY,     -- the writing token's orchestrator id, e.g. 'review-bot'
  version     INTEGER NOT NULL DEFAULT 1,
  last_stamp  TEXT,                          -- newest finished run
  next_run_at TEXT,                          -- the runner's next scheduled run (from its scheduler)
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE review_runs (
  routine     TEXT NOT NULL,
  stamp       TEXT NOT NULL,                 -- '2026-10-08T180000Z': fixed width, so it sorts by time
  started_at  TEXT NOT NULL,
  finished_at TEXT,                          -- NULL while running
  result      TEXT NOT NULL CHECK (result IN ('running', 'ok', 'failed', 'timed_out', 'report_invalid', 'seed')),
  dry         INTEGER NOT NULL DEFAULT 0,
  has_report  INTEGER NOT NULL DEFAULT 0,    -- 1 when the run stored a report (and so PR state)
  report_sha  TEXT,                          -- sha256 of the canonical request body; NULL while running
  data        TEXT NOT NULL CHECK (json_valid(data)),  -- the run record (docs/reviews.md)
  PRIMARY KEY (routine, stamp)
) WITHOUT ROWID;

CREATE TABLE review_prs (                    -- current state, upserted by each report
  routine    TEXT NOT NULL,
  number     INTEGER NOT NULL,
  url        TEXT NOT NULL,                  -- trailing slashes trimmed; the GitHub hook's match key
  role       TEXT NOT NULL,                  -- reviewing | mine | bot
  status     TEXT NOT NULL,                  -- the report's status taxonomy (docs/reviews.md)
  needs_you  INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL CHECK (json_valid(data)),   -- the report's PR entry as is
  last_stamp TEXT NOT NULL,                  -- the run that last wrote it; older runs never overwrite it
  gh         TEXT CHECK (gh IS NULL OR json_valid(gh)), -- between-run facts from the GitHub hook
  gone_at    TEXT,                           -- dropped out of the newest report (merged, closed, stale)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (routine, number)
) WITHOUT ROWID;
-- The GitHub hook's lookup (a later change): every routine's row for a PR
-- url, so it spans routines (review-bot and review-bot-dry can both track one).
-- Every other read is by routine and seeks the primary key; a routine holds
-- about 45 current PRs plus 30 days of gone ones, so its counts and the
-- cron's gone_at prune scan a few hundred rows and need no index of their own.
CREATE INDEX review_prs_url ON review_prs (url);

-- Read per PR (the primary key, newest first). A run's own actions are in its
-- run record, so nothing reads events by stamp; the cron's age prune scans the
-- table (about 90 days x 4 runs x a few events).
CREATE TABLE review_events (                 -- per PR per run, only with an action or changes
  routine TEXT NOT NULL,
  number  INTEGER NOT NULL,
  stamp   TEXT NOT NULL,
  data    TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (routine, number, stamp)
) WITHOUT ROWID;

-- The change log, from the head row only. The Worker bumps the head in the
-- same db.batch as every other write (worker/reviews.ts), so a 45-PR run is
-- one change row and the delta's 500-change window isn't eaten by reviews.
-- orchestrator = routine lets the routine's own token see its rows.
--
-- These INSERTs can't conflict (changes has no unique key but its
-- AUTOINCREMENT seq), so the outer statement's conflict policy, which a
-- trigger's statements inherit, never matters: the head is written with
-- INSERT ... ON CONFLICT DO UPDATE, which fires the UPDATE trigger.
CREATE TRIGGER review_routines_ai AFTER INSERT ON review_routines BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator)
  VALUES ('reviews', NEW.routine, 'create', NEW.version, NULL, NEW.updated_by, NEW.updated_at, NEW.routine);
END;

CREATE TRIGGER review_routines_au AFTER UPDATE ON review_routines BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator)
  VALUES ('reviews', NEW.routine, 'update', NEW.version, NULL, NEW.updated_by, NEW.updated_at, NEW.routine);
END;

-- DELETE /api/reviews/:routine (admin). Deletes carry actor '' like every
-- other delete trigger: it can't see who asked.
CREATE TRIGGER review_routines_ad AFTER DELETE ON review_routines BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator)
  VALUES ('reviews', OLD.routine, 'delete', NULL, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.routine);
END;
