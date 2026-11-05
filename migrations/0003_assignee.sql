-- Item assignee: an email, or absent for unassigned. A query column and
-- index like status and orchestrator (0001), so GET /api/items?assignee=
-- is an index lookup. VIRTUAL generated columns can be added in place; the
-- change-log triggers don't read it, so they stay as 0002 left them.

ALTER TABLE docs ADD COLUMN assignee TEXT GENERATED ALWAYS AS (json_extract(data, '$.assignee')) VIRTUAL;
CREATE INDEX docs_assignee ON docs (collection, assignee);
