// Orchestrator docs (the Team tab). Orchestrator tokens read and patch only
// their own; humans need the admin role to write them. A token reads and
// writes only its own fleet's (docs/api.md "Fleets"): the first fleet to
// create an id owns it.

import type { Orchestrator } from "../../shared/types.ts";
import { fleetWhere, orchestratorScope, requireFleet, requireFull, requireFullRole, requireRole, type Caller } from "../auth.ts";
import { deleteInFleet, stampFleet } from "../fleets.ts";
import { badRequest, forbidden, ifVersion, isObject, json, notFound } from "../http.ts";
import { docResponse, opRoute, type WriteOp } from "../ops.ts";
import type { Ctx, Route } from "../router.ts";
import { deleteDoc, getDoc, listDocs, mergePatch } from "../store.ts";
import { dropPins } from "./pins.ts";

const ORCH = "orchestrators";

function requireSelfOrFull(caller: Caller, id: string): void {
  const scope = orchestratorScope(caller);
  if (scope !== null && scope !== id) throw forbidden("Not this token's orchestrator");
}

function requireWriter(caller: Caller, id: string): void {
  requireSelfOrFull(caller, id);
  requireRole(caller, "admin");
}

function bodyData(body: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(body.data)) throw badRequest("data must be an object");
  return body.data;
}

async function list(c: Ctx): Promise<Response> {
  requireFull(c.caller);
  const f = fleetWhere(c.caller);
  return json({ orchestrators: await listDocs<Orchestrator>(c.env.DB, ORCH, f.sql, f.binds, "id") });
}

async function get(c: Ctx): Promise<Response> {
  requireSelfOrFull(c.caller, c.params.id);
  const doc = await getDoc<Orchestrator>(c.env.DB, ORCH, c.params.id);
  if (!doc) throw notFound(`No orchestrator ${c.params.id}`);
  requireFleet(c.caller, doc.data, "Manager");
  return json(doc);
}

// An orchestrator token may create its own doc; replacing one is manager/human only.
export function putOrchestratorOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Orchestrator> {
  requireWriter(c.caller, id);
  const scoped = orchestratorScope(c.caller) !== null;
  const input = bodyData(body);
  return {
    collection: ORCH,
    id,
    ifVersion: ifVersion(body.if_version),
    build: (cur) => {
      const next: Orchestrator = { ...input };
      stampFleet(c.caller, cur?.data ?? null, next, true, "Manager");
      if (cur && scoped) throw forbidden("Orchestrator tokens can create their doc, not replace it");
      return { ...next, id, updated_at: (input.updated_at as string | undefined) ?? c.now };
    },
    respond: docResponse,
  };
}

export function patchOrchestratorOp(c: Ctx, id: string, body: Record<string, unknown>): WriteOp<Orchestrator> {
  requireWriter(c.caller, id);
  const p = bodyData(body);
  return {
    collection: ORCH,
    id,
    ifVersion: ifVersion(body.if_version),
    build: (cur) => {
      if (!cur) throw notFound(`No orchestrator ${id}`);
      const next = mergePatch(cur.data, p);
      stampFleet(c.caller, cur.data, next, false, "Manager");
      next.id = id;
      if (!("updated_at" in p)) next.updated_at = c.now;
      return next;
    },
    respond: docResponse,
  };
}

async function del(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "admin");
  const id = c.params.id;
  // Everyone's pins on it go in the same transaction, under the same version pin.
  const del = (pin: number | undefined) => deleteDoc(c.env.DB, ORCH, id, pin, [dropPins(c.env.DB, "orch", id, ORCH, pin)]);
  await deleteInFleet(c, ORCH, id, ifVersion(c.url.searchParams.get("if_version")), del, "Manager");
  return json({ ok: true });
}

export const orchestratorRoutes: Route[] = [
  ["GET", "/orchestrators", list],
  ["GET", "/orchestrators/:id", get],
  ["PUT", "/orchestrators/:id", opRoute(putOrchestratorOp)],
  ["PATCH", "/orchestrators/:id", opRoute(patchOrchestratorOp)],
  ["DELETE", "/orchestrators/:id", del],
];
