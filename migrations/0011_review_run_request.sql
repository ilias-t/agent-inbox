-- A human's request for an on-demand run of a review routine (docs/reviews.md
-- "Run requests"): the Reviews tab's Run button writes it, and the routine's
-- poller reads it with the routine's token, starts one run and records
-- how that went. One request per routine at a time, so it lives on the head
-- row: every write to it bumps the head's version, and the head's existing
-- triggers log that write's one change row (the open tab refetches on it).
--
-- Safe on live data: it only adds a nullable column. No existing row is
-- written and nothing is logged. The Worker that is live while this runs
-- (deploy.yml migrates before it deploys), and one brought back by `wrangler
-- rollback`, select the head's columns by name (worker/reviews.ts HEAD_COLS),
-- so they never read it; their head upserts leave it as it is.
--
-- Rolling back: ALTER TABLE review_routines DROP COLUMN run_request.

ALTER TABLE review_routines ADD COLUMN run_request TEXT CHECK (run_request IS NULL OR json_valid(run_request));
