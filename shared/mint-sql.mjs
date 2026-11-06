// The statement that mints a bearer token, shared by POST /api/tokens (worker/routes/tokens.ts, with bound
// parameters) and scripts/create-token.mjs (with SQL literals), so both apply exactly the same rules
// (docs/api.md "Tokens" and "Fleets"):
//   - a live (unrevoked) token's name is unique;
//   - a manager token (scope "orchestrator") belongs to the fleet that owns its manager id: the fleet of
//     orchestrators/<id> if it exists, else of review routine <id>, else of the oldest live manager token for <id>.
//     The fleet asked for may be left out (null: take the owner's, the default fleet without an owner); one given
//     ("default" included) must be the owner's;
//   - the fleet is the default fleet or a registered one (a fleets/<id> doc exists).
// All of it is one INSERT ... SELECT ... WHERE, so concurrent mints can't break a rule between a check and the
// write. Plain SQL in a .mjs file so the Node script imports it as is; shared/mint-sql.d.mts types it.
//
// `v` maps each value to a SQL expression (a placeholder such as "?1", or a literal): id, name, scope, orchestrator
// (NULL for scope "manager"), hash (the secret's SHA-256 hex), now, by (created_by), fleet (NULL: inherit;
// 'default'; or a fleet id). Each expression may be used several times. Every statement is one line, as
// `wrangler d1 execute --command` takes it.

// Fleets compare as text, the default fleet as 'default': stored, it is NULL (or, hand-written, 'default'), so a
// manager id the default fleet owns isn't mistaken for one nobody owns.
const norm = (col) => `coalesce(nullif(${col}, 'default'), 'default')`;

function ctes(v) {
  const owner =
    `CASE WHEN ${v.scope} = 'orchestrator' THEN coalesce(` +
    `(SELECT ${norm("fleet")} FROM docs WHERE collection = 'orchestrators' AND id = ${v.orchestrator}), ` +
    `(SELECT ${norm("fleet")} FROM review_routines WHERE routine = ${v.orchestrator}), ` +
    `(SELECT ${norm("fleet")} FROM tokens WHERE scope = 'orchestrator' AND orchestrator = ${v.orchestrator} AND revoked_at IS NULL ORDER BY created_at, id LIMIT 1)` +
    `) END`;
  return `WITH owner(f) AS (SELECT ${owner}), chosen(f) AS (SELECT coalesce(${v.fleet}, (SELECT f FROM owner), 'default'))`;
}

const OWNER = "(SELECT f FROM owner)";
const CHOSEN = "(SELECT f FROM chosen)";
const KNOWN = `(${CHOSEN} = 'default' OR EXISTS (SELECT 1 FROM docs WHERE collection = 'fleets' AND id = ${CHOSEN}))`;

// The guarded insert. `createFleet` (the script's --create-fleet, with a named fleet) lets the fleet asked for be
// unregistered: mintFleetDocSql then registers it, only if the token landed.
export function mintTokenSql(v, { createFleet = false } = {}) {
  const known = createFleet ? `(${KNOWN} OR ${CHOSEN} = ${v.fleet})` : KNOWN;
  return (
    `${ctes(v)} ` +
    `INSERT INTO tokens (id, name, scope, orchestrator, secret_hash, created_at, created_by, fleet) ` +
    `SELECT ${v.id}, ${v.name}, ${v.scope}, ${v.orchestrator}, ${v.hash}, ${v.now}, ${v.by}, nullif(${CHOSEN}, 'default') ` +
    `WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE name = ${v.name} AND revoked_at IS NULL) ` +
    `AND (${OWNER} IS NULL OR ${OWNER} = ${CHOSEN}) ` +
    `AND ${known}`
  );
}

// --create-fleet: an empty fleets/<fleet> doc, written only when the token was stored and the fleet has no doc yet,
// so a refused mint leaves nothing behind. The columns the Worker's writes set (worker/store.ts insertStmt), so the
// change log records it as any other create.
export function mintFleetDocSql(v) {
  return (
    `INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) ` +
    `SELECT 'fleets', ${v.fleet}, '{}', 1, ${v.now}, ${v.now}, ${v.by} ` +
    `WHERE EXISTS (SELECT 1 FROM tokens WHERE id = ${v.id}) ` +
    `AND NOT EXISTS (SELECT 1 FROM docs WHERE collection = 'fleets' AND id = ${v.fleet})`
  );
}

// Run after the insert (with the same values): whether it landed, and if not, what refused it. One row:
// {inserted, name_taken, owner, fleet, fleet_known} (owner and fleet as text, 'default' for the default fleet;
// owner null when the id has none).
export function mintOutcomeSql(v) {
  return (
    `${ctes(v)} ` +
    `SELECT EXISTS (SELECT 1 FROM tokens WHERE id = ${v.id}) AS inserted, ` +
    `EXISTS (SELECT 1 FROM tokens WHERE name = ${v.name} AND revoked_at IS NULL AND id <> ${v.id}) AS name_taken, ` +
    `${OWNER} AS owner, ${CHOSEN} AS fleet, ${KNOWN} AS fleet_known`
  );
}

// Why a mint was refused, from mintOutcomeSql's row: {status, message} as the API answers (409 or 400).
export function mintRefusal(row, { name, orchestrator }) {
  if (row.name_taken) {
    return { status: 409, message: `A live token is already named "${name}". Pick another name, or revoke that token first.` };
  }
  if (row.owner !== null && row.owner !== undefined && row.owner !== row.fleet) {
    return { status: 409, message: `Manager ${orchestrator} belongs to fleet ${row.owner}: mint its token there (or leave the fleet out)` };
  }
  if (!row.fleet_known) {
    return { status: 400, message: `No fleet ${row.fleet}: create it first (Settings, or PUT /api/fleets/${row.fleet})` };
  }
  return { status: 409, message: "The token wasn't stored (something changed during the request): try again" };
}
