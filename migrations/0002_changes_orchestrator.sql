-- Record which orchestrator each change belongs to, at write time, so an
-- orchestrator token's change feed is a plain filter: it keeps seeing its
-- own history after an item is deleted or reassigned. Items use their
-- orchestrator field, orchestrator docs their id, qa messages their parent
-- item's orchestrator.

ALTER TABLE changes ADD COLUMN orchestrator TEXT;
CREATE INDEX changes_orchestrator ON changes (orchestrator, seq);

-- Best-effort backfill from the docs as they are now.
UPDATE changes SET orchestrator = CASE
  WHEN collection = 'items' THEN
    (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items' AND d.id = changes.doc_id)
  WHEN collection = 'orchestrators' THEN doc_id
  WHEN collection LIKE 'items/%/qa' THEN
    (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
       AND d.id = substr(changes.collection, 7, length(changes.collection) - 9))
END;

DROP TRIGGER docs_ai;
DROP TRIGGER docs_au;
DROP TRIGGER docs_ad;

-- 'items/<id>/qa' → <id>: skip "items/" (6 chars), drop "/qa" (3).
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator)
  VALUES (NEW.collection, NEW.id, 'create', NEW.version, NEW.status, NEW.updated_by, NEW.updated_at,
    CASE
      WHEN NEW.collection = 'items' THEN NEW.orchestrator
      WHEN NEW.collection = 'orchestrators' THEN NEW.id
      WHEN NEW.collection LIKE 'items/%/qa' THEN
        (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(NEW.collection, 7, length(NEW.collection) - 9))
    END);
END;

CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator)
  VALUES (NEW.collection, NEW.id, 'update', NEW.version, NEW.status, NEW.updated_by, NEW.updated_at,
    CASE
      WHEN NEW.collection = 'items' THEN NEW.orchestrator
      WHEN NEW.collection = 'orchestrators' THEN NEW.id
      WHEN NEW.collection LIKE 'items/%/qa' THEN
        (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(NEW.collection, 7, length(NEW.collection) - 9))
    END);
END;

-- The Worker deletes an item's qa before the item, so the lookup still finds it.
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at, orchestrator)
  VALUES (OLD.collection, OLD.id, 'delete', NULL, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN OLD.collection = 'items' THEN OLD.orchestrator
      WHEN OLD.collection = 'orchestrators' THEN OLD.id
      WHEN OLD.collection LIKE 'items/%/qa' THEN
        (SELECT d.orchestrator FROM docs d WHERE d.collection = 'items'
           AND d.id = substr(OLD.collection, 7, length(OLD.collection) - 9))
    END);
END;
