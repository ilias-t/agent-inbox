// Orchestrator docs (the Team tab). Orchestrator tokens read and patch only
// their own; humans need the admin role to write them.

import type { Orchestrator } from "../../shared/types.ts";
import { orchestratorScope, requireFull, requireFullRole, requireRole, type Caller } from "../auth.ts";
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
  return json({ orchestrators: await listDocs<Orchestrator>(c.env.DB, ORCH, "", [], "id") });
}

async function get(c: Ctx): Promise<Response> {
  requireSelfOrFull(c.caller, c.params.id);
  const doc = await getDoc<Orchestrator>(c.env.DB, ORCH, c.params.id);
  if (!doc) throw notFound(`No orchestrator ${c.params.id}`);
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
      if (cur && scoped) throw forbidden("Orchestrator tokens can create their doc, not replace it");
      return { ...input, id, updated_at: (input.updated_at as string | undefined) ?? c.now };
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
      next.id = id;
      if (!("updated_at" in p)) next.updated_at = c.now;
      return next;
    },
    respond: docResponse,
  };
}

async function del(c: Ctx): Promise<Response> {
  requireFullRole(c.caller, "admin");
  const pin = ifVersion(c.url.searchParams.get("if_version"));
  // Everyone's pins on it go in the same transaction, under the same version pin.
  const r = await deleteDoc(c.env.DB, ORCH, c.params.id, pin, [dropPins(c.env.DB, "orch", c.params.id, ORCH, pin)]);
  if (r === "missing") throw notFound(`No orchestrator ${c.params.id}`);
  return json({ ok: true });
}

export const orchestratorRoutes: Route[] = [
  ["GET", "/orchestrators", list],
  ["GET", "/orchestrators/:id", get],
  ["PUT", "/orchestrators/:id", opRoute(putOrchestratorOp)],
  ["PATCH", "/orchestrators/:id", opRoute(patchOrchestratorOp)],
  ["DELETE", "/orchestrators/:id", del],
];
