-- Pins are per person, like snoozes (0007): a row per (human, thing pinned),
-- written by PUT / DELETE /api/pins/... and read back by that human's
-- /api/state. A pin keeps the thing in a "Pinned" group at the top of its own
-- list for that human only; nobody else's lists change, and agents never see
-- pins.
--
--   kind 'item':  ref is the item id (any status: it follows the item to History).
--   kind 'orch':  ref is the orchestrator id.
--   kind 'pr':    ref is '<routine>/<n>', a PR a review routine tracks (0009).
--
-- Safe on live data: it only adds a new table, its index and its triggers.
-- Nothing on docs, snoozes, the review tables or changes is altered, no
-- existing row is read or written, and nothing is logged. The Worker that is
-- live while this runs (deploy.yml migrates before it deploys), and one brought
-- back by `wrangler rollback`, never touch the table, so its triggers never
-- fire for them; their deletes of items and orchestrators leave pins behind,
-- which the new Worker's daily cron drops (worker/prune.ts prunePins).
--
-- Rolling back: DROP TABLE pins (its triggers and index go with it).

CREATE TABLE pins (
  email       TEXT NOT NULL,                -- lowercased, like users.email
  kind        TEXT NOT NULL,                -- 'item' | 'orch' | 'pr'
  ref         TEXT NOT NULL,
  created_at  TEXT NOT NULL,                -- ISO 8601 UTC, when it was pinned
  PRIMARY KEY (email, kind, ref)
) WITHOUT ROWID;
-- Dropping everyone's pins on a thing (an item or orchestrator delete, the cron).
CREATE INDEX pins_target ON pins (kind, ref);

-- Writes to pins go to the change log, so the pinner's other devices refetch.
-- The actor is the pinner; /api/changes shows these rows to that human only
-- (never to other humans or any token), and orchestrator stays NULL. doc_id
-- is '<kind>:<ref>'. A pin is never updated in place (pinning again is a
-- no-op), so there is no update trigger.
CREATE TRIGGER pins_ai AFTER INSERT ON pins BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('pins', NEW.kind || ':' || NEW.ref, 'create', NULL, NULL, 'human:' || NEW.email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER pins_ad AFTER DELETE ON pins BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('pins', OLD.kind || ':' || OLD.ref, 'delete', NULL, NULL, 'human:' || OLD.email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
