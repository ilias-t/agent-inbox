// PUT / DELETE /api/pins/<kind>/<ref>: a human pins an item, an orchestrator or a Reviews PR to the top of their own
// list (docs/api.md, "Pins"). Per person, like snoozes: a row in pins (migration 0010) for the caller only, never a
// doc write, so no version moves and nobody else's lists change. Not for tokens: agents never see pins.

import type { PinKind, PinResponse } from "../../shared/types.ts";
import { requireHuman } from "../auth.ts";
import { badRequest, json, notFound } from "../http.ts";
import type { Ctx, Route } from "../router.ts";
import { pinClause, type DeletePin } from "../store.ts";

// What each kind pins, and the statement's test that it exists (?1 the ref; ?2, ?3 a PR's routine and number).
const TARGET: Record<PinKind, { what: string; exists: string }> = {
  item: { what: "item", exists: "SELECT 1 FROM docs WHERE collection = 'items' AND id = ?1" },
  orch: { what: "orchestrator", exists: "SELECT 1 FROM docs WHERE collection = 'orchestrators' AND id = ?1" },
  pr: { what: "PR", exists: "SELECT 1 FROM review_prs WHERE routine = ?2 AND number = ?3" },
};

function caller(c: Ctx): string {
  requireHuman(c.caller);
  const p = c.caller.principal;
  return p.kind === "human" ? p.email.toLowerCase() : "";
}

// The pinned thing from the path: its ref, and for a PR its routine and number.
function target(c: Ctx, kind: PinKind): { ref: string; routine: string | null; n: number | null } {
  if (kind !== "pr") return { ref: c.params.id, routine: null, n: null };
  const { routine, n } = c.params;
  if (!/^[1-9]\d{0,8}$/.test(n)) throw badRequest("The PR number must be a positive integer");
  return { ref: `${routine}/${n}`, routine, n: Number(n) };
}

// Pinning again keeps the first pin (and logs nothing). Only while the thing exists, checked in the same statement.
const pin = (kind: PinKind) => async (c: Ctx): Promise<Response> => {
  const email = caller(c), t = target(c, kind), db = c.env.DB;
  const [ins, row] = await db.batch<{ created_at: string }>([
    db
      .prepare(
        `INSERT INTO pins (email, kind, ref, created_at)
         SELECT ?4, ?5, ?1, ?6 WHERE EXISTS (${TARGET[kind].exists})
         ON CONFLICT (email, kind, ref) DO NOTHING`,
      )
      .bind(t.ref, t.routine, t.n, email, kind, c.now),
    db.prepare("SELECT created_at FROM pins WHERE email = ? AND kind = ? AND ref = ?").bind(email, kind, t.ref),
  ]);
  const at = row.results[0]?.created_at;
  if (!at && !ins.meta.changes) throw notFound(`No ${TARGET[kind].what} ${t.ref}`);
  return json({ kind, ref: t.ref, pinned: true, created_at: at } satisfies PinResponse);
};

// Unpinning what isn't pinned (or no longer exists) is a no-op.
const unpin = (kind: PinKind) => async (c: Ctx): Promise<Response> => {
  const email = caller(c), t = target(c, kind);
  await c.env.DB.prepare("DELETE FROM pins WHERE email = ? AND kind = ? AND ref = ?").bind(email, kind, t.ref).run();
  return json({ kind, ref: t.ref, pinned: false, created_at: null } satisfies PinResponse);
};

// Everyone's pins on an item or orchestrator, dropped in the same transaction as its delete (worker/store.ts
// deleteDoc's `before`), under the same version pin: all happen or none does.
export function dropPins(db: D1Database, kind: "item" | "orch", id: string, collection: string, pin: DeletePin) {
  return db
    .prepare(
      `DELETE FROM pins WHERE kind = ?1 AND ref = ?2 AND EXISTS
         (SELECT 1 FROM docs WHERE collection = ?3 AND id = ?2 AND ${pinClause("?4", "?5")})`,
    )
    .bind(kind, id, collection, pin.version ?? null, pin.createdAt ?? null);
}

export const pinRoutes: Route[] = [
  ["PUT", "/pins/item/:id", pin("item")],
  ["DELETE", "/pins/item/:id", unpin("item")],
  ["PUT", "/pins/orch/:id", pin("orch")],
  ["DELETE", "/pins/orch/:id", unpin("orch")],
  ["PUT", "/pins/pr/:routine/:n", pin("pr")],
  ["DELETE", "/pins/pr/:routine/:n", unpin("pr")],
];
