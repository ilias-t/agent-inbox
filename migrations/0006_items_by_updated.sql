-- Archived items page newest first: /api/state?archived=n takes the n most
-- recently updated, and GET /api/items?before=&limit= continues from a
-- (updated_at, id) cursor. This index serves both in order, so a page reads
-- its own rows instead of sorting every archived item.

CREATE INDEX docs_status_updated ON docs (collection, status, updated_at, id);
