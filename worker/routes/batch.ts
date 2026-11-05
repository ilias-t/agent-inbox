// POST /api/batch: several writes in one D1 transaction, all or nothing. Each
// op is a write the caller could send alone, built by that route's own op
// builder, so validation and authorization are the route's. Decide, deletes,
// the lease, people, schedule and tokens are not batchable.

import { atIndex, badRequest, checkId, isObject, json } from "../http.ts";
import type { OpBuilder, WriteOp } from "../ops.ts";
import type { Ctx, Route } from "../router.ts";
import { mutateMany } from "../store.ts";
import { archiveOp, claimOp, patchItemOp, putItemOp, qaOp, withdrawOp } from "./items.ts";
import { patchMetaOp, putMetaOp } from "./meta.ts";
import { patchOrchestratorOp, putOrchestratorOp } from "./orchestrators.ts";

export const MAX_OPS = 50;

// op name → builder, and the route it stands for.
const OPS: Record<string, OpBuilder> = {
  "item.put": putItemOp, // PUT /items/:id
  "item.patch": patchItemOp, // PATCH /items/:id
  "item.claim": claimOp, // POST /items/:id/claim
  "item.archive": archiveOp, // POST /items/:id/archive
  "item.withdraw": withdrawOp, // POST /items/:id/withdraw
  "item.qa": qaOp, // POST /items/:id/qa
  "orchestrator.put": putOrchestratorOp, // PUT /orchestrators/:id
  "orchestrator.patch": patchOrchestratorOp, // PATCH /orchestrators/:id
  "meta.put": putMetaOp, // PUT /meta/:id
  "meta.patch": patchMetaOp, // PATCH /meta/:id
};

// One op: {op, id, ...that route's body}.
function buildOp(c: Ctx, raw: unknown): WriteOp {
  if (!isObject(raw)) throw badRequest("each op must be an object");
  const builder = typeof raw.op === "string" && Object.hasOwn(OPS, raw.op) ? OPS[raw.op] : undefined;
  if (!builder) throw badRequest(`op must be one of ${Object.keys(OPS).join(", ")}`);
  if (typeof raw.id !== "string") throw badRequest("id is required");
  return builder(c, checkId(raw.id), raw);
}

async function batch(c: Ctx): Promise<Response> {
  const { ops } = await c.body();
  if (!Array.isArray(ops) || ops.length === 0) throw badRequest("ops must be a non-empty array");
  if (ops.length > MAX_OPS) throw badRequest(`A batch takes at most ${MAX_OPS} ops, got ${ops.length}`);

  const seen = new Set<string>();
  const writes = ops.map((raw, i) => {
    try {
      const w = buildOp(c, raw);
      const key = `${w.collection}/${w.id}`;
      if (seen.has(key)) throw badRequest(`${key} appears twice: a batch writes each doc once`);
      seen.add(key);
      return w;
    } catch (e) {
      throw atIndex(e, i);
    }
  });

  const done = await mutateMany(c.env.DB, writes, { actor: c.caller.actor, now: c.now });
  // Committed: now the side effects, once per write.
  done.forEach(({ doc, created }, i) => writes[i].after?.(doc, created));
  return json({ results: done.map(({ doc, created }, i) => writes[i].respond(doc, created).body) });
}

export const batchRoutes: Route[] = [["POST", "/batch", batch]];
