-- Team inbox phase 2: people and their roles in a table, replacing the
-- meta/people doc (names and ntfy topics) and the ADMIN_EMAILS env var.
-- How a role resolves is in worker/users.ts and docs/deploy.md ("People and
-- roles").
--
-- Safe on live data: it only adds. Everyone in meta/people is copied with
-- their name and topic and NO role, which resolves exactly as having no row
-- does, so nobody's access changes until an admin saves a role in Settings.
-- meta/people itself is left in place, unread from now on: the Worker that
-- is live while this runs (deploy.yml migrates before it deploys), and one
-- brought back by `wrangler rollback`, still read it.

CREATE TABLE users (
  email       TEXT PRIMARY KEY,              -- lowercased, like item assignees
  -- NULL: no role saved (someone who only set a name or topic, or was copied
  -- from meta/people); resolves as if there were no row.
  role        TEXT CHECK (role IN ('admin', 'decider', 'viewer')),
  name        TEXT,                          -- display name, set by the person or an admin
  ntfy_topic  TEXT,                          -- private: only its owner ever reads it back
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT ''       -- actor of the last write, for the change log
);
CREATE INDEX users_role ON users (role);

-- meta/people was {"<email>": {"name"?, "ntfy_topic"?}}. Entries that aren't
-- objects carry nothing and are skipped; blank strings become NULL. Keys were
-- written lowercased, but a hand-edited one could collide once lowercased:
-- then a value already copied wins and a missing one is filled in.
INSERT INTO users (email, role, name, ntfy_topic, created_at, updated_at, updated_by)
SELECT lower(trim(p.key)),
       NULL,
       CASE WHEN json_type(p.value, '$.name') = 'text' THEN nullif(trim(json_extract(p.value, '$.name')), '') END,
       CASE WHEN json_type(p.value, '$.ntfy_topic') = 'text' THEN nullif(trim(json_extract(p.value, '$.ntfy_topic')), '') END,
       d.created_at,
       d.updated_at,
       'migration:0005'
FROM docs AS d, json_each(d.data) AS p
WHERE d.collection = 'meta' AND d.id = 'people' AND json_type(d.data) = 'object'
  AND p.type = 'object' AND trim(p.key) <> ''
ON CONFLICT (email) DO UPDATE SET
  name = coalesce(users.name, excluded.name),
  ntfy_topic = coalesce(users.ntfy_topic, excluded.ntfy_topic);

-- Writes to users go to the change log like doc writes (created after the
-- copy, so it logs nothing), so open pages refetch when a name or role
-- changes. orchestrator stays NULL: orchestrator tokens never see them.
CREATE TRIGGER users_ai AFTER INSERT ON users BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('users', NEW.email, 'create', NULL, NULL, NEW.updated_by, NEW.updated_at);
END;

CREATE TRIGGER users_au AFTER UPDATE ON users BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('users', NEW.email, 'update', NULL, NULL, NEW.updated_by, NEW.updated_at);
END;

CREATE TRIGGER users_ad AFTER DELETE ON users BEGIN
  INSERT INTO changes (collection, doc_id, op, version, status, actor, at)
  VALUES ('users', OLD.email, 'delete', NULL, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
