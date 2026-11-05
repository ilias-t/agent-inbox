-- agent-inbox schema. One generic document table mirrors the artifact's
-- collections 1:1 (items, orchestrators, meta, items/<id>/qa), so every
-- write keeps the artifact's {id, data, version} semantics and the import
-- is a straight copy. Triggers feed the change log behind /api/changes, so
-- no write path can forget it.

CREATE TABLE docs (
  collection  TEXT    NOT NULL,              -- 'items' | 'orchestrators' | 'meta' | 'items/<id>/qa'
  id          TEXT    NOT NULL,
  data        TEXT    NOT NULL CHECK (json_valid(data)),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,              -- ISO 8601
  updated_at  TEXT    NOT NULL,
  updated_by  TEXT    NOT NULL DEFAULT '',   -- actor: 'human:<email>' | 'token:<name>' | 'hook:<source>'
  -- Query columns for items (NULL elsewhere).
  status       TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL,
  orchestrator TEXT GENERATED ALWAYS AS (json_extract(data, '$.orchestrator')) VIRTUAL,
  qa_pending   INTEGER GENERATED ALWAYS AS (json_extract(data, '$.qa_pending')) VIRTUAL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX docs_status ON docs (collection, status);
CREATE INDEX docs_orchestrator ON docs (collection, orchestrator);
CREATE INDEX docs_qa_pending ON docs (collection, qa_pending);

CREATE TABLE changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  collection  TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  op          TEXT NOT NULL,                 -- 'create' | 'update' | 'delete'
  version     INTEGER,                       -- the doc's new version (NULL on delete)
  status      TEXT,                          -- item status after the write, when it has one
  actor       TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL
);
CREATE INDEX changes_doc ON changes (collection, doc_id);

CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES (NEW.collection, NEW.id, 'create', NEW.version, NEW.status, NEW.updated_by, NEW.updated_at);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES (NEW.collection, NEW.id, 'update', NEW.version, NEW.status, NEW.updated_by, NEW.updated_at);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES (OLD.collection, OLD.id, 'delete', NULL, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Bearer tokens for agents. Only the SHA-256 of the secret is stored.
CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,            -- public part of the token: ait_<id>_<secret>
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('manager', 'orchestrator')),
  orchestrator  TEXT,                        -- required when scope = 'orchestrator'
  secret_hash   TEXT NOT NULL,               -- hex SHA-256 of the secret part
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT '',
  last_used_at  TEXT,
  revoked_at    TEXT,
  CHECK (scope = 'manager' OR orchestrator IS NOT NULL)
);
