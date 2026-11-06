-- Fleets (docs/api.md "Fleets"): several orchestrators share one deployment,
-- each scoped to its own fleet. A fleet is a data field on items and manager
-- docs (`data.fleet`, absent for the default fleet), a column on tokens and on
-- review routines (NULL for the default fleet), and a column on every change
-- row, so a token's change feed is a plain filter, as `changes.orchestrator`
-- (0002) is for manager tokens.
--
-- Safe on live data: it adds nullable columns, three indexes, and recreates the
-- six change-log triggers on docs and review_routines with one more column.
-- No existing row is written (nothing is backfilled: every row is the default
-- fleet, which is NULL), and nothing is logged. The Worker that is live while
-- this runs (deploy.yml migrates before it deploys), and one brought back by
-- `wrangler rollback`, name the columns of every table it reads or writes, so
-- it never sees the new ones; its writes log through the new triggers with
-- fleet NULL, the default fleet, which is what it writes.
--
-- One assumption about existing data: no item or manager doc already has a
-- `fleet` key in its data (items keep unknown extra fields). One that does
-- reads as belonging to that fleet from now on. Check before applying:
--   SELECT collection, id FROM docs WHERE json_extract(data, '$.fleet') IS NOT NULL;
--
-- Rolling back: roll the Worker back first (`wrangler rollback`); this Worker
-- reads tokens.fleet, so dropping it under a live one fails every bearer call.
-- The schema can stay: it is additive, and an older Worker never names it.
-- To take it out too, in this order (SQLite refuses to drop a column an index
-- or a trigger names; test/worker/migration-fleets.test.ts runs exactly this):
--   DROP INDEX docs_fleet; DROP INDEX changes_fleet; DROP INDEX changes_shared;
--   DROP TRIGGER docs_ai; DROP TRIGGER docs_au; DROP TRIGGER docs_ad;
--   DROP TRIGGER review_routines_ai; DROP TRIGGER review_routines_au; DROP TRIGGER review_routines_ad;
--   the three CREATE TRIGGER docs_* statements of 0002, and the three
--   CREATE TRIGGER review_routines_* statements of 0009, copied from those files;
--   ALTER TABLE docs DROP COLUMN fleet; ALTER TABLE changes DROP COLUMN fleet;
--   ALTER TABLE tokens DROP COLUMN fleet; ALTER TABLE review_routines DROP COLUMN fleet;
--   DELETE FROM d1_migrations WHERE name = '0012_fleets.sql' (so it applies again).
-- A Worker from before fleets doesn't read tokens.fleet, so under it every
-- token reads and writes every fleet again. Roll the Worker back only while no
-- named fleet is in use; once one is, revoke every token you don't trust with
-- every fleet's data first.

-- A query column, as assignee (0003). Its index leads with the fleet and then
-- serves a fleet's reads as docs_status_updated (0006) serves everyone's: its
-- items by status, the archived count, and archived pages newest first.
ALTER TABLE docs ADD COLUMN fleet TEXT GENERATED ALWAYS AS (json_extract(data, '$.fleet')) VIRTUAL;
CREATE INDEX docs_fleet ON docs (collection, fleet, status, updated_at, id);

ALTER TABLE tokens ADD COLUMN fleet TEXT;              -- NULL: the default fleet
ALTER TABLE review_routines ADD COLUMN fleet TEXT;     -- the fleet of the token that first wrote it

ALTER TABLE changes ADD COLUMN fleet TEXT;
CREATE INDEX changes_fleet ON changes (fleet, seq);
-- The rows every fleet sees (people, shared meta, a person's own snoozes and
-- pins), so a named fleet's feed reads them without the default fleet's rows.
CREATE INDEX changes_shared ON changes (seq) WHERE fleet IS NULL AND collection IN ('users', 'meta', 'snoozes', 'pins');

-- 0002's triggers plus the fleet each change belongs to, at write time: an
-- item's or manager doc's own fleet, a qa message's parent item's fleet, the
-- fleet a per-fleet meta doc names (`manager:<fleet>`, `lease:<fleet>`,
-- `schedule:<fleet>`; any other meta id is shared), and a fleet doc's own id
-- (the default fleet's, `fleets/default`, logs as the default fleet). Every
-- other row logs NULL, as before.
--
-- An update that moves an item or manager doc to another fleet (an admin's)
-- logs one more row first, under the fleet it left, so that fleet's feed
-- wakes and its delta drops the doc. It carries no status: the doc isn't that
-- fleet's to read any more.
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
      WHEN NEW.collection = 'meta' AND (NEW.id GLOB 'manager:*' OR NEW.id GLOB 'lease:*' OR NEW.id GLOB 'schedule:*')
        THEN nullif(substr(NEW.id, instr(NEW.id, ':') + 1), 'default')
      WHEN NEW.collection = 'fleets' THEN nullif(NEW.id, 'default')
    END);
END;

CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator, fleet)
  SELECT NEW.collection, NEW.id, 'update', NEW.version, NULL, NEW.updated_by, NEW.updated_at,
    CASE WHEN NEW.collection = 'items' THEN OLD.orchestrator ELSE NEW.id END, OLD.fleet
  WHERE NEW.collection IN ('items', 'orchestrators') AND OLD.fleet IS NOT NEW.fleet;
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
      WHEN NEW.collection = 'meta' AND (NEW.id GLOB 'manager:*' OR NEW.id GLOB 'lease:*' OR NEW.id GLOB 'schedule:*')
        THEN nullif(substr(NEW.id, instr(NEW.id, ':') + 1), 'default')
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
      WHEN OLD.collection = 'meta' AND (OLD.id GLOB 'manager:*' OR OLD.id GLOB 'lease:*' OR OLD.id GLOB 'schedule:*')
        THEN nullif(substr(OLD.id, instr(OLD.id, ':') + 1), 'default')
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
