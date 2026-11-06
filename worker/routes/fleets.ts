// The fleet registry (docs/api.md "Fleets registry"): `fleets/<id>` docs, a named fleet's label, colour and manager
// id prefix. A fleet exists once its doc does; the default fleet always does, and `fleets/default` only labels it.
// People read every fleet's; an orchestrator token reads its own fleet's, and may create it while it is missing.
// Only admin humans change one.
//
// There is deliberately no DELETE: requireRegistered (worker/fleets.ts) reads the registry before the writes that
// name a fleet, which is only safe because a registered id stays registered. Tokens, items, manager docs, routines
// and meta docs all name fleets, so removing one would also strand them.

import { DEFAULT_FLEET, FLEET_COLOR_RE, FLEET_KEYS, FLEET_LABEL_MAX, FLEET_PREFIX_RE, type Fleet } from "../../shared/types.ts";
import { fleetScope, requireFull, requireRole, type Caller } from "../auth.ts";
import { parseFleet } from "../fleets.ts";
import { badRequest, forbidden, ifVersion, isObject, json, notFound } from "../http.ts";
import { docResponse, opRoute, type WriteOp } from "../ops.ts";
import type { Ctx, Route } from "../router.ts";
import { getDoc, listDocs, mergePatch } from "../store.ts";

const FLEETS = "fleets";

// The `:id` of a fleet route: `default` or a fleet id (the router's id check is looser), else 400.
function fleetId(raw: string): string {
  return parseFleet(raw, "A fleet's id") ?? DEFAULT_FLEET;
}

// A token reaches only its own fleet's doc (403 before anything is read, so a 404 says nothing about another
// fleet); a manager token none, as with the manager list.
function requireOwnFleet(c: Caller, id: string): void {
  requireFull(c);
  const own = fleetScope(c);
  if (own !== undefined && id !== (own ?? DEFAULT_FLEET)) throw forbidden("That is another fleet's");
}

// The stored form of a fleet doc: only the known fields, each checked; a null (or, on a replace, a missing field)
// leaves it out.
export function validateFleet(input: Record<string, unknown>): Fleet {
  const out: Fleet = {};
  for (const key of Object.keys(input)) {
    if (!(FLEET_KEYS as readonly string[]).includes(key)) throw badRequest(`Unknown fleet field ${key}: use ${FLEET_KEYS.join(", ")}`);
  }
  const { label, color, id_prefix } = input;
  if (label !== undefined && label !== null) {
    const v = typeof label === "string" ? label.trim() : "";
    if (!v || v.length > FLEET_LABEL_MAX) throw badRequest(`label must be a string of 1-${FLEET_LABEL_MAX} characters`);
    out.label = v;
  }
  if (color !== undefined && color !== null) {
    if (typeof color !== "string" || !FLEET_COLOR_RE.test(color)) throw badRequest("color must be #rrggbb");
    out.color = color.toLowerCase();
  }
  if (id_prefix !== undefined && id_prefix !== null) {
    if (typeof id_prefix !== "string" || !FLEET_PREFIX_RE.test(id_prefix)) {
      throw badRequest("id_prefix must be a letter then up to 7 letters or digits");
    }
    out.id_prefix = id_prefix;
  }
  return out;
}

function bodyData(body: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(body.data)) throw badRequest("data must be an object");
  return body.data;
}

async function list(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  const own = fleetScope(c.caller);
  const fleets =
    own === undefined
      ? await listDocs<Fleet>(c.env.DB, FLEETS, "", [], "id")
      : await listDocs<Fleet>(c.env.DB, FLEETS, "AND id = ?", [own ?? DEFAULT_FLEET], "id");
  return json({ fleets });
}

async function get(c: Ctx): Promise<Response> {
  const id = fleetId(c.params.id);
  requireOwnFleet(c.caller, id);
  const doc = await getDoc<Fleet>(c.env.DB, FLEETS, id);
  if (!doc) throw notFound(`No fleet ${id}`);
  return json(doc);
}

// An admin creates or replaces it; an orchestrator token only creates its own fleet's.
function putFleetOp(c: Ctx, raw: string, body: Record<string, unknown>): WriteOp<Fleet> {
  const id = fleetId(raw);
  requireOwnFleet(c.caller, id);
  requireRole(c.caller, "admin");
  const scoped = fleetScope(c.caller) !== undefined;
  const data = validateFleet(bodyData(body));
  return {
    collection: FLEETS,
    id,
    ifVersion: ifVersion(body.if_version),
    // Before the pin: a token's write of an existing doc is 403, never a 409 carrying it.
    authorize: () => {
      if (scoped) throw forbidden("An orchestrator token can create its fleet's doc, not replace it");
    },
    build: () => data,
    respond: docResponse,
  };
}

function patchFleetOp(c: Ctx, raw: string, body: Record<string, unknown>): WriteOp<Fleet> {
  const id = fleetId(raw);
  requireRole(c.caller, "admin");
  if (c.caller.principal.kind !== "human") throw forbidden("Only admins change a fleet");
  const patch = bodyData(body);
  validateFleet(patch); // the field names and values, before anything is read
  return {
    collection: FLEETS,
    id,
    ifVersion: ifVersion(body.if_version),
    build: (cur) => {
      if (!cur) throw notFound(`No fleet ${id}`);
      return validateFleet(mergePatch(cur.data, patch) as Record<string, unknown>);
    },
    respond: docResponse,
  };
}

export const fleetRoutes: Route[] = [
  ["GET", "/fleets", list],
  ["GET", "/fleets/:id", get],
  ["PUT", "/fleets/:id", opRoute(putFleetOp)],
  ["PATCH", "/fleets/:id", opRoute(patchFleetOp)],
];
