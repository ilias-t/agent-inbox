// Generic meta docs (manager, schedule) and the Run-tick-now request. The
// lease is only writable through /api/lease, so its rules can't be bypassed.
// meta/people (the people list before the users table) is neither read nor
// written: /api/people and /api/users replaced it. Humans need the admin role
// to write meta docs, the decider role to request a tick.

import type { ManagerMeta } from "../../shared/types.ts";
import { requireFull, requireFullRole, requireRole } from "../auth.ts";
import { badRequest, ifVersion, isObject, json, notFound, optString } from "../http.ts";
import { docResponse, opRoute, type OpBuilder, type WriteOp } from "../ops.ts";
import type { Ctx, Route } from "../router.ts";
import { getDoc, mergePatch, mutate } from "../store.ts";
import { checkSchedule } from "./schedule.ts";

const PEOPLE_ONLY = "meta/people was replaced by the users table: use /api/people/me and /api/users";

async function get(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  if (c.params.id === "people") throw badRequest(PEOPLE_ONLY);
  const doc = await getDoc(c.env.DB, "meta", c.params.id);
  if (!doc) throw notFound(`No meta/${c.params.id}`);
  return json(doc);
}

function metaOp(mode: "put" | "patch"): OpBuilder {
  return (c, id, body): WriteOp<Record<string, unknown>> => {
    requireFull(c.caller);
    if (id === "lease") throw badRequest("meta/lease is written through /api/lease");
    if (id === "people") throw badRequest(PEOPLE_ONLY);
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
        return id === "schedule" ? { ...checkSchedule(next) } : next;
      },
      respond: docResponse,
    };
  };
}

export const putMetaOp = metaOp("put");
export const patchMetaOp = metaOp("patch");

async function tickRequest(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "decider");
  const note = optString(await c.body(), "note", 2000);
  const { doc } = await mutate<ManagerMeta>(
    c.env.DB,
    "meta",
    "manager",
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
