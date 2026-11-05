-- The urls items and orchestrators link to, so POST /hooks/github finds the
-- docs a PR event is about with an index search instead of reading every item
-- and orchestrator (archived ones too) and matching in JS.
--
-- A table, not a generated column: an item's urls are arrays (links and
-- evidence), and SQLite can only index one value per row. Triggers keep it
-- current, like the change log (0001), so no write path can forget it.
--
--   items:         every links[].url and evidence[].url that is a string,
--                  verbatim. The hook's match (the PR url itself, or the url
--                  followed by "/" or "#") is an equality plus two ranges on
--                  doc_links_url.
--   orchestrators: pr.url when it is a string, trailing slashes trimmed
--                  (rtrim(x, '/') is the hook's .replace(/\/+$/, "")).
--
-- Safe on live data: it only adds, and it fills the table from the docs as
-- they are now. No doc changes (no version bump, nothing in the change log).
-- The Worker that is live while this runs (deploy.yml migrates before it
-- deploys), and one brought back by `wrangler rollback`, never read the table;
-- their writes fire the triggers all the same, so it stays current for the
-- new one. Writes made by the triggers don't count in changes(), so
-- landedClause (worker/store.ts) still sees only the doc write.

CREATE TABLE doc_links (
  collection  TEXT NOT NULL,                 -- 'items' | 'orchestrators'
  id          TEXT NOT NULL,                 -- the doc's id
  url         TEXT NOT NULL,
  PRIMARY KEY (collection, id, url)          -- a url in both links and evidence is one row
) WITHOUT ROWID;
CREATE INDEX doc_links_url ON doc_links (collection, url);

-- The url is read from each element itself (linear in the number of links;
-- a path from the doc's root would re-walk the array for every element). The
-- CASE keeps json_extract off elements that aren't objects: on a plain string
-- element it would fail the write with "malformed JSON", and SQLite doesn't
-- promise to evaluate a WHERE's terms in order. Links or evidence that aren't
-- arrays carry nothing, as in the hook.
INSERT OR IGNORE INTO doc_links (collection, id, url)
SELECT d.collection, d.id, CASE WHEN l.type = 'object' THEN json_extract(l.value, '$.url') END
FROM docs AS d, json_each(d.data, '$.links') AS l
WHERE d.collection = 'items' AND json_type(d.data, '$.links') = 'array'
  AND CASE WHEN l.type = 'object' THEN json_type(l.value, '$.url') END = 'text';

INSERT OR IGNORE INTO doc_links (collection, id, url)
SELECT d.collection, d.id, CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.url') END
FROM docs AS d, json_each(d.data, '$.evidence') AS e
WHERE d.collection = 'items' AND json_type(d.data, '$.evidence') = 'array'
  AND CASE WHEN e.type = 'object' THEN json_type(e.value, '$.url') END = 'text';

INSERT OR IGNORE INTO doc_links (collection, id, url)
SELECT d.collection, d.id, rtrim(json_extract(d.data, '$.pr.url'), '/')
FROM docs AS d
WHERE d.collection = 'orchestrators' AND json_type(d.data, '$.pr.url') = 'text';

-- Insert and update both replace the doc's rows, so the table can't drift
-- whatever wrote the doc. Updates that leave the urls alone (decisions,
-- pr_state, qa bookkeeping: most of them) skip it; json_type is compared too,
-- since an array and a string holding its JSON extract to the same text.
--
-- The trigger INSERTs can never conflict, so they never fail the doc write:
-- they run after the DELETE of the doc's rows, and UNION (not UNION ALL)
-- leaves one row per url, however often links and evidence repeat it. An
-- OR IGNORE here wouldn't do: a trigger's statements run under the conflict
-- policy of the statement that fired it (an import --replace's ON CONFLICT DO
-- UPDATE aborts on a conflict).
CREATE TRIGGER doc_links_ai AFTER INSERT ON docs
WHEN NEW.collection IN ('items', 'orchestrators') BEGIN
  DELETE FROM doc_links WHERE collection = NEW.collection AND id = NEW.id;
  INSERT INTO doc_links (collection, id, url)
  SELECT NEW.collection, NEW.id, CASE WHEN l.type = 'object' THEN json_extract(l.value, '$.url') END
  FROM json_each(NEW.data, '$.links') AS l
  WHERE NEW.collection = 'items' AND json_type(NEW.data, '$.links') = 'array'
    AND CASE WHEN l.type = 'object' THEN json_type(l.value, '$.url') END = 'text'
  UNION
  SELECT NEW.collection, NEW.id, CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.url') END
  FROM json_each(NEW.data, '$.evidence') AS e
  WHERE NEW.collection = 'items' AND json_type(NEW.data, '$.evidence') = 'array'
    AND CASE WHEN e.type = 'object' THEN json_type(e.value, '$.url') END = 'text'
  UNION
  SELECT NEW.collection, NEW.id, rtrim(json_extract(NEW.data, '$.pr.url'), '/')
  WHERE NEW.collection = 'orchestrators' AND json_type(NEW.data, '$.pr.url') = 'text';
END;

CREATE TRIGGER doc_links_au AFTER UPDATE ON docs
WHEN (NEW.collection IN ('items', 'orchestrators') OR OLD.collection IN ('items', 'orchestrators'))
  AND (OLD.collection IS NOT NEW.collection OR OLD.id IS NOT NEW.id
    OR json_type(OLD.data, '$.links') IS NOT json_type(NEW.data, '$.links')
    OR json_extract(OLD.data, '$.links') IS NOT json_extract(NEW.data, '$.links')
    OR json_type(OLD.data, '$.evidence') IS NOT json_type(NEW.data, '$.evidence')
    OR json_extract(OLD.data, '$.evidence') IS NOT json_extract(NEW.data, '$.evidence')
    OR json_type(OLD.data, '$.pr.url') IS NOT json_type(NEW.data, '$.pr.url')
    OR json_extract(OLD.data, '$.pr.url') IS NOT json_extract(NEW.data, '$.pr.url')) BEGIN
  DELETE FROM doc_links WHERE (collection = OLD.collection AND id = OLD.id) OR (collection = NEW.collection AND id = NEW.id);
  INSERT INTO doc_links (collection, id, url)
  SELECT NEW.collection, NEW.id, CASE WHEN l.type = 'object' THEN json_extract(l.value, '$.url') END
  FROM json_each(NEW.data, '$.links') AS l
  WHERE NEW.collection = 'items' AND json_type(NEW.data, '$.links') = 'array'
    AND CASE WHEN l.type = 'object' THEN json_type(l.value, '$.url') END = 'text'
  UNION
  SELECT NEW.collection, NEW.id, CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.url') END
  FROM json_each(NEW.data, '$.evidence') AS e
  WHERE NEW.collection = 'items' AND json_type(NEW.data, '$.evidence') = 'array'
    AND CASE WHEN e.type = 'object' THEN json_type(e.value, '$.url') END = 'text'
  UNION
  SELECT NEW.collection, NEW.id, rtrim(json_extract(NEW.data, '$.pr.url'), '/')
  WHERE NEW.collection = 'orchestrators' AND json_type(NEW.data, '$.pr.url') = 'text';
END;

CREATE TRIGGER doc_links_ad AFTER DELETE ON docs
WHEN OLD.collection IN ('items', 'orchestrators') BEGIN
  DELETE FROM doc_links WHERE collection = OLD.collection AND id = OLD.id;
END;
