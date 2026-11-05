// Write ops: one doc write described as data, so a route and POST /api/batch
// run the same validation and authorization. A builder checks the caller and
// the body up front (throwing 400/403), and returns the write plus what to
// answer and what to do once it has committed (ntfy pushes).

import type { Doc } from "../shared/types.ts";
import { json } from "./http.ts";
import type { Ctx, Handler } from "./router.ts";
import { mutate, type DocWrite } from "./store.ts";

export interface WriteOp<T = any> extends DocWrite<T> {
  // The response body and status the route answers with.
  respond(doc: Doc<T>, created: boolean): { body: unknown; status: number };
  // Side effects after the commit, once per committed write.
  after?(doc: Doc<T>, created: boolean): void;
}

export type OpBuilder = (c: Ctx, id: string, body: Record<string, unknown>) => WriteOp;

// The doc itself, 201 on create.
export const docResponse = (doc: Doc<unknown>, created: boolean) => ({ body: doc, status: created ? 201 : 200 });

export async function runOne(c: Ctx, op: WriteOp): Promise<Response> {
  const { doc, created } = await mutate(
    c.env.DB,
    op.collection,
    op.id,
    { actor: c.caller.actor, now: c.now, ifVersion: op.ifVersion, extra: op.extra },
    op.build,
  );
  op.after?.(doc, created);
  const { body, status } = op.respond(doc, created);
  return json(body, status);
}

// The route for a builder: `:id` from the path, the op from the body.
export const opRoute =
  (builder: OpBuilder): Handler =>
  async (c) =>
    runOne(c, builder(c, c.params.id, await c.body()));
