// Generic meta docs (manager, schedule) and the Run-tick-now request. The
// lease is only writable through /api/lease, so its rules can't be bypassed.
// meta/people (the people list before the users table) is neither read nor
// written: /api/people and /api/users replaced it. Humans need the admin role
// to write meta docs, the decider role to request a tick. Each fleet has its own
// meta/manager (status, digest, tick request) and schedule: a named fleet's
// token names them by their bare ids, as before fleets (docs/api.md "Fleets").

import type { ManagerMeta } from "../../shared/types.ts";
import { requireFull, requireFullRole, requireRole } from "../auth.ts";
import { badRequest, ifVersion, isObject, json, notFound, optString } from "../http.ts";
import { docResponse, opRoute, type OpBuilder, type WriteOp } from "../ops.ts";
import type { Ctx, Route } from "../router.ts";
import { getDoc, mergePatch, mutate } from "../store.ts";
import { checkSchedule } from "./schedule.ts";
import { metaFleet, metaId, requireMetaFleet, resolveMetaId, targetFleet } from "../fleets.ts";

const PEOPLE_ONLY = "meta/people was replaced by the users table: use /api/people/me and /api/users";

// A fleet's meta doc is named in its id (`meta/manager:<fleet>`; a token's bare id is its own fleet's), never by
// a separate fleet: one there would otherwise be ignored, and the call land on the default fleet's doc.
function refuseFleetParam(c: Ctx, body?: Record<string, unknown>): void {
  if (c.url.searchParams.has("fleet") || (body && body.fleet !== undefined && body.fleet !== null)) {
    throw badRequest("Name a fleet's meta doc in its id (meta/<id>:<fleet>), not with fleet");
  }
}

async function get(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  refuseFleetParam(c);
  if (c.params.id === "people") throw badRequest(PEOPLE_ONLY);
  const id = resolveMetaId(c.caller, c.params.id);
  requireMetaFleet(c.caller, id);
  const doc = await getDoc(c.env.DB, "meta", id);
  if (!doc) throw notFound(`No meta/${id}`);
  return json(doc);
}

function metaOp(mode: "put" | "patch"): OpBuilder {
  return (c, asked, body): WriteOp<Record<string, unknown>> => {
    requireFull(c.caller);
    refuseFleetParam(c, body);
    const id = resolveMetaId(c.caller, asked);
    const perFleet = metaFleet(id);
    if (id === "lease" || perFleet?.base === "lease") throw badRequest(`meta/${id} is written through /api/lease`);
    if (id === "people") throw badRequest(PEOPLE_ONLY);
    requireMetaFleet(c.caller, id);
    requireRole(c.caller, "admin"); // the schedule included
    if (!isObject(body.data)) throw badRequest("data must be an object");
    const input = body.data;
    return {
      collection: "meta",
      id,
      ifVersion: ifVersion(body.if_version),
      build: (cur) => {
        if (mode === "patch" && !cur) throw notFound(`No meta/${id}`);
        const next = mode === "patch" ? mergePatch(cur!.data, input) : input;
        return id === "schedule" || perFleet?.base === "schedule" ? { ...checkSchedule(next) } : next;
      },
      respond: docResponse,
    };
  };
}

export const putMetaOp = metaOp("put");
export const patchMetaOp = metaOp("patch");

// The fleet's own meta/manager: a token's fleet, or the `fleet` a person names in the body (the default fleet's
// without one).
async function tickRequest(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "decider");
  const body = await c.body();
  const fleet = targetFleet(c, body); // before the note: another fleet's is 403 whatever it says
  const note = optString(body, "note", 2000);
  const { doc } = await mutate<ManagerMeta>(
    c.env.DB,
    "meta",
    metaId("manager", fleet),
    { actor: c.caller.actor, now: c.now },
    (cur) => ({ ...(cur?.data ?? {}), tick_requested_at: c.now, tick_requested_note: note || null }),
  );
  return json(doc);
}

export const metaRoutes: Route[] = [
  ["POST", "/meta/manager/tick-request", tickRequest],
  ["GET", "/meta/:id", get],
  ["PUT", "/meta/:id", opRoute(putMetaOp)],
  ["PATCH", "/meta/:id", opRoute(patchMetaOp)],
];
