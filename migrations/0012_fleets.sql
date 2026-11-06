-- Fleets (docs/api.md "Fleets"): several orchestrators share one deployment,
-- each scoped to its own fleet. A fleet is a data field on items and manager
-- docs (`data.fleet`, absent for the default fleet), a column on tokens and on
-- review routines (NULL for the default fleet), and a column on every change
-- row, so a token's change feed is a plain filter, as `changes.orchestrator`
-- (0002) is for manager tokens.
--
-- Safe on live data: it adds nullable columns, two indexes, and recreates the
-- six change-log triggers on docs and review_routines with one more column.
-- No existing row is written (nothing is backfilled: every row is the default
-- fleet, which is NULL), and nothing is logged. The Worker that is live while
-- this runs (deploy.yml migrates before it deploys), and one brought back by
-- `wrangler rollback`, name the columns of every table it reads or writes, so
-- it never sees the new ones; its writes log through the new triggers with
-- fleet NULL, the default fleet, which is what it writes.
--
-- Rolling back, in this order (SQLite refuses to drop an indexed column):
--   DROP INDEX docs_fleet; DROP INDEX changes_fleet;
--   recreate docs_ai, docs_au, docs_ad as 0002 has them, and
--   review_routines_ai, _au, _ad as 0009 has them;
--   ALTER TABLE docs DROP COLUMN fleet; ALTER TABLE changes DROP COLUMN fleet;
--   ALTER TABLE tokens DROP COLUMN fleet; ALTER TABLE review_routines DROP COLUMN fleet.
-- Roll the Worker back before a token bound to a named fleet exists, or revoke
-- those tokens first: a Worker from before fleets doesn't read tokens.fleet,
-- so it would treat them as unscoped.

-- A query column and index, as assignee (0003).
ALTER TABLE docs ADD COLUMN fleet TEXT GENERATED ALWAYS AS (json_extract(data, '$.fleet')) VIRTUAL;
CREATE INDEX docs_fleet ON docs (collection, fleet);

ALTER TABLE tokens ADD COLUMN fleet TEXT;              -- NULL: the default fleet
ALTER TABLE review_routines ADD COLUMN fleet TEXT;     -- the fleet of the token that first wrote it

ALTER TABLE changes ADD COLUMN fleet TEXT;
CREATE INDEX changes_fleet ON changes (fleet, seq);

-- 0002's triggers plus the fleet each change belongs to, at write time: an
-- item's or manager doc's own fleet, a qa message's parent item's fleet, a
-- meta doc's `:<fleet>` suffix (`manager:<fleet>`), and a fleet doc's own id
-- (the default fleet's doc, `fleets/default`, logs as the default fleet).
-- Every other collection logs NULL, as before.
DROP TRIGGER docs_ai;
DROP TRIGGER docs_au;
DROP TRIGGER docs_ad;

-- 'items/<id>/qa' → <id>: skip "items/" (6 chars), drop "/qa" (3).
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  VALUES (NEW.collection, NEW.id, 'create', NEW.version, NEW.status, NEW.updated_by, NEW.updated_at,
    CASE
      WHEN NEW.collection = 'items' THEN NEW.orchestrator
      WHEN NEW.collection = 'orchestrators' THEN NEW.id
      WHEN NEW.collection LIKE 'items/%/qa' THEN
        (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(NEW.collection, 7, length(NEW.collection) - 9))
    END,
    CASE
      WHEN NEW.collection IN ('items', 'orchestrators') THEN NEW.fleet
      WHEN NEW.collection LIKE 'items/%/qa' THEN
        (SELECT d.fleet FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(NEW.collection, 7, length(NEW.collection) - 9))
      WHEN NEW.collection = 'meta' AND instr(NEW.id, ':') > 0 THEN substr(NEW.id, instr(NEW.id, ':') + 1)
      WHEN NEW.collection = 'fleets' THEN nullif(NEW.id, 'default')
    END);
END;

CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  VALUES (NEW.collection, NEW.id, 'update', NEW.version, NEW.status, NEW.updated_by, NEW.updated_at,
    CASE
      WHEN NEW.collection = 'items' THEN NEW.orchestrator
      WHEN NEW.collection = 'orchestrators' THEN NEW.id
      WHEN NEW.collection LIKE 'items/%/qa' THEN
        (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(NEW.collection, 7, length(NEW.collection) - 9))
    END,
    CASE
      WHEN NEW.collection IN ('items', 'orchestrators') THEN NEW.fleet
      WHEN NEW.collection LIKE 'items/%/qa' THEN
        (SELECT d.fleet FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(NEW.collection, 7, length(NEW.collection) - 9))
      WHEN NEW.collection = 'meta' AND instr(NEW.id, ':') > 0 THEN substr(NEW.id, instr(NEW.id, ':') + 1)
      WHEN NEW.collection = 'fleets' THEN nullif(NEW.id, 'default')
    END);
END;

-- The Worker deletes an item's qa before the item, so the lookups still find it.
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  VALUES (OLD.collection, OLD.id, 'delete', NULL, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN OLD.collection = 'items' THEN OLD.orchestrator
      WHEN OLD.collection = 'orchestrators' THEN OLD.id
      WHEN OLD.collection LIKE 'items/%/qa' THEN
        (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(OLD.collection, 7, length(OLD.collection) - 9))
    END,
    CASE
      WHEN OLD.collection IN ('items', 'orchestrators') THEN OLD.fleet
      WHEN OLD.collection LIKE 'items/%/qa' THEN
        (SELECT d.fleet FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(OLD.collection, 7, length(OLD.collection) - 9))
      WHEN OLD.collection = 'meta' AND instr(OLD.id, ':') > 0 THEN substr(OLD.id, instr(OLD.id, ':') + 1)
      WHEN OLD.collection = 'fleets' THEN nullif(OLD.id, 'default')
    END);
END;

-- 0009's triggers plus the routine's fleet.
DROP TRIGGER review_routines_ai;
DROP TRIGGER review_routines_au;
DROP TRIGGER review_routines_ad;

CREATE TRIGGER review_routines_ai AFTER INSERT ON review_routines BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  VALUES ('reviews', NEW.routine, 'create', NEW.version, NULL, NEW.updated_by, NEW.updated_at, NEW.routine, NEW.fleet);
END;

CREATE TRIGGER review_routines_au AFTER UPDATE ON review_routines BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  VALUES ('reviews', NEW.routine, 'update', NEW.version, NULL, NEW.updated_by, NEW.updated_at, NEW.routine, NEW.fleet);
END;

CREATE TRIGGER review_routines_ad AFTER DELETE ON review_routines BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  VALUES ('reviews', OLD.routine, 'delete', NULL, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.routine, OLD.fleet);
END;
