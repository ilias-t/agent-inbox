-- Snoozes are per person: a row per (item, human), written by
-- POST /api/items/:id/snooze and read back by that human's /api/state.
-- Before this they lived on the item doc (data.snoozed_until / snoozed_by),
-- which hid the item from everyone's Inbox and bumped its version, so every
-- ntfy link and open page pinned on that version went stale.
--
-- Safe on live data: it only adds. Each open item's snooze that is still in
-- the future becomes a row for the human in its snoozed_by. The old fields
-- stay in the docs untouched (no version bump): the new Worker never reads
-- them and drops them on the item's next write, and a Worker brought back by
-- `wrangler rollback` still reads them.

CREATE TABLE snoozes (
  item_id     TEXT NOT NULL,
  email       TEXT NOT NULL,                -- lowercased, like users.email
  until       TEXT NOT NULL,                -- ISO 8601 UTC, toISOString() form
  created_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, email)
);
-- /api/state reads one person's snoozes.
CREATE INDEX snoozes_email ON snoozes (email, until);

-- julianday() is NULL for a value that isn't a time, so those are skipped;
-- strftime() writes the rest in the form the Worker writes.
INSERT INTO snoozes (item_id, email, until, created_at)
SELECT d.id,
       lower(substr(json_extract(d.data, '$.snoozed_by'), 7)),
       strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(d.data, '$.snoozed_until')),
       d.updated_at
FROM docs AS d
WHERE d.collection = 'items' AND d.status = 'open'
  AND json_type(d.data, '$.snoozed_by') = 'text'
  AND json_extract(d.data, '$.snoozed_by') LIKE 'human:%_'
  AND json_type(d.data, '$.snoozed_until') = 'text'
  AND julianday(json_extract(d.data, '$.snoozed_until')) > julianday('now')
ON CONFLICT (item_id, email) DO NOTHING;

-- Writes to snoozes go to the change log (created after the copy, so it
-- logs nothing), so the snoozer's other devices refetch. The actor is the
-- snoozer; /api/changes shows these rows to that human only (never to
-- other humans or any token), and orchestrator stays NULL.
CREATE TRIGGER snoozes_ai AFTER INSERT ON snoozes BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('snoozes', NEW.item_id, 'create', NULL, NULL, 'human:' || NEW.email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER snoozes_au AFTER UPDATE ON snoozes BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('snoozes', NEW.item_id, 'update', NULL, NULL, 'human:' || NEW.email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER snoozes_ad AFTER DELETE ON snoozes BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('snoozes', OLD.item_id, 'delete', NULL, NULL, 'human:' || OLD.email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
