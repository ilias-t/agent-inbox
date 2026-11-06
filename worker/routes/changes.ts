// The change feed behind the manager's wake loop and the UI's refresh.

import type { Change } from "../../shared/types.ts";
import { orchestratorScope } from "../auth.ts";
import { fleetChangesSql, fleetFilter } from "../fleets.ts";
import { badRequest, json } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { latestSeq } from "../store.ts";

const PAGE = 500;
const WAIT_MAX_S = 25;
const POLL_MS = 1500;

const COLLECTION_FILTERS: Record<string, string> = {
  items: "AND collection = 'items'",
  orchestrators: "AND collection = 'orchestrators'",
  meta: "AND collection = 'meta'",
  qa: "AND collection LIKE 'items/%/qa'",
  // Review routines (docs/reviews.md): one row per write, from the routine's head.
  reviews: "AND collection = 'reviews'",
};

// An orchestrator token sees its items, their qa threads and its own doc:
// the triggers record each change's orchestrator at write time (migration
// 0002), so deletes and reassigned items keep their history. Filtered in SQL
// before the LIMIT so a page of others' changes can't hide its own.
const SCOPE_FILTER = "AND orchestrator = ?1";

// Fleets (docs/api.md "Fleets"): the triggers record each change's fleet too
// (migration 0012). A token sees its own fleet's rows (a manager token those
// of its own orchestrator id in it); a human, every fleet, or one with
// ?fleet=, as that fleet's orchestrator token sees it. ?4 is the fleet. A
// manager token's rows are found through changes_orchestrator, as before
// (`+fleet` keeps the planner off changes_fleet).
const FLEET_FILTER = (named: boolean) => `AND ${fleetChangesSql(named, "?4")}`;
const MANAGER_FLEET_FILTER = "AND +fleet IS ?4";

// Snoozes and pins are one human's own (migrations 0007, 0010): only that
// human's feed shows them, so teammates' pages don't refetch and no token
// (the manager's `wait --human` included) ever wakes on one. ?3 is the
// caller's own actor, or "" for a token.
const SNOOZE_FILTER = "AND (collection NOT IN ('snoozes', 'pins') OR actor = ?3)";

function intParam(v: string | null, name: string): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${name} must be a non-negative number`);
  return n;
}

async function changes(c: Ctx): Promise<Response> {
  const q = c.url.searchParams;
  const db = c.env.DB;
  const since = intParam(q.get("since"), "since");
  if (since === undefined) return json({ cursor: await latestSeq(db), changes: [] });
  const wait = Math.min(intParam(q.get("wait"), "wait") ?? 0, WAIT_MAX_S);
  const collection = q.get("collection");
  if (collection && !(collection in COLLECTION_FILTERS)) {
    throw badRequest(`collection must be one of ${Object.keys(COLLECTION_FILTERS).join(", ")}`);
  }
  const scope = orchestratorScope(c.caller);
  const fleet = fleetFilter(c.caller, q);
  const fleetSql = fleet === undefined ? "" : scope !== null ? MANAGER_FLEET_FILTER : FLEET_FILTER(fleet !== null);
  const sql = `SELECT seq, collection, doc_id, op, version, status, actor, at FROM changes
    WHERE seq > ?2 ${collection ? COLLECTION_FILTERS[collection] : ""} ${scope !== null ? SCOPE_FILTER : ""} ${fleetSql} ${SNOOZE_FILTER}
    ORDER BY seq LIMIT ${PAGE}`;
  const p = c.caller.principal;
  const self = p.kind === "human" ? `human:${p.email.toLowerCase()}` : "";
  // ?4 is bound only when the SQL names it: the default fleet's orchestrator-token filter doesn't.
  const bindFleet = fleetSql.includes("?4");
  const stmt = db.prepare(sql).bind(scope ?? "", Math.floor(since), self, ...(bindFleet ? [fleet] : []));

  // A long-poll the client has abandoned (tab hidden, navigation, network
  // drop) stops querying D1 straight away rather than at its deadline. The
  // signal fires on disconnect thanks to the enable_request_signal flag
  // (wrangler.jsonc); nobody reads what we return then. `wrangler dev` doesn't
  // pass disconnects through to the Worker, so locally a poll runs to its deadline.
  const signal = c.request.signal;
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    if (signal.aborted) return json({ cursor: Math.floor(since), changes: [] });
    const { results } = await stmt.all<Change>();
    const remaining = deadline - Date.now();
    if (results.length || remaining <= 0) {
      return json({ cursor: results.length ? results[results.length - 1].seq : Math.floor(since), changes: results });
    }
    await sleep(Math.min(POLL_MS, remaining), signal);
  }
}

// Resolves after ms, or as soon as the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

export const changeRoutes: Route[] = [["GET", "/changes", changes]];
