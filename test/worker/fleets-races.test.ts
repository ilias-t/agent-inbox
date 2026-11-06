// Fleets (docs/api.md "Fleets") under races: an admin's move, or another fleet's write, landing between a token's
// check and its write. A proxy over the D1 binding runs that other write just before the token's write statement
// does, so the interleaving is the same every run.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../worker/index.ts";
import { human, mintFleetToken, setRoles, uid } from "./helpers.ts";
import { reportOf, stamp } from "./reviews-helpers.ts";

// The binding, but `between` runs once, just before the first statement whose SQL matches `re` runs (on its own or
// in a batch).
function interleaved(db: D1Database, re: RegExp, between: () => Promise<unknown>): D1Database {
  let done = false;
  const once = async (sql: string) => {
    if (!done && re.test(sql)) {
      done = true;
      await between();
    }
  };
  const sqlOf = new WeakMap<object, string>();
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(t, k) {
        if (k === "bind") return (...args: unknown[]) => wrap(t.bind(...args), sql);
        if (k === "first" || k === "all" || k === "run" || k === "raw") {
          return async (...args: unknown[]) => {
            await once(sql);
            return (t as any)[k](...args);
          };
        }
        const v = (t as any)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    sqlOf.set(p, sql);
    real.set(p, stmt);
    return p;
  };
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          for (const s of stmts) await once(sqlOf.get(s) ?? "");
          return t.batch(stmts.map((s) => real.get(s) ?? s));
        };
      }
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

async function callWith(db: D1Database, token: string, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://inbox.test/agent${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, DB: db },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// An admin's move, as the Worker writes one (a version bump), straight to D1.
const moveTo = (collection: string, id: string, fleet: string) => () =>
  env.DB.prepare("UPDATE docs SET data = json_set(data, '$.fleet', ?), version = version + 1 WHERE collection = ? AND id = ?")
    .bind(fleet, collection, id)
    .run();

let A: string;
beforeAll(async () => {
  await setRoles({ "you@test": "admin" });
  A = (await mintFleetToken("fa")).secret;
});

const newItem = async () => {
  const id = uid("race");
  const r = await callWith(env.DB, A, "PUT", `/api/items/${id}`, { data: { type: "decision", title: "secret" } });
  expect(r.status).toBe(201);
  return { id, version: r.body.version as number };
};

describe("a move between a token's check and its write", () => {
  for (const pinned of [false, true]) {
    it(`refuses the write (403, no current) on the doc it moved to, ${pinned ? "pinned" : "unpinned"}`, async () => {
      const { id, version } = await newItem();
      const db = interleaved(env.DB, /^\s*UPDATE docs SET data/, moveTo("items", id, "fb"));
      const r = await callWith(db, A, "PATCH", `/api/items/${id}`, { data: { summary: "x" }, ...(pinned ? { if_version: version } : {}) });
      expect(r.status).toBe(403);
      expect(r.body).not.toHaveProperty("current");
      const now = (await human.get(`/api/items/${id}`)).body;
      expect(now.data).toMatchObject({ fleet: "fb" });
      expect(now.data).not.toHaveProperty("summary");
    });
  }

  it("refuses a delete of the doc it moved", async () => {
    const { id } = await newItem();
    const db = interleaved(env.DB, /^\s*DELETE FROM docs WHERE collection = \?1 AND EXISTS/, moveTo("items", id, "fb"));
    const r = await callWith(db, A, "DELETE", `/api/items/${id}`);
    expect(r.status).toBe(403);
    expect((await human.get(`/api/items/${id}`)).body.data.fleet).toBe("fb");
  });

  it("refuses a batch op on it, writing nothing", async () => {
    const { id } = await newItem();
    const other = uid("race-other");
    const db = interleaved(env.DB, /^\s*INSERT INTO docs \(collection, id, data, version, created_at, updated_at\)\s+SELECT NULL/, moveTo("items", id, "fb"));
    const r = await callWith(db, A, "POST", "/api/batch", {
      ops: [
        { op: "item.put", id: other, data: { type: "info", title: "mine" } },
        { op: "item.patch", id, data: { summary: "x" } },
      ],
    });
    expect([r.status, r.body.index]).toEqual([403, 1]);
    expect(r.body).not.toHaveProperty("current");
    expect((await human.get(`/api/items/${other}`)).status).toBe(404);
  });
});

describe("two fleets racing to create one review routine", () => {
  it("the one whose batch lands second gets 403 and writes nothing", async () => {
    const r = uid("rv-race");
    const a = (await mintFleetToken("fa", "orchestrator", r)).secret;
    // Fleet fb's routine appears after fleet fa's token found none, before its batch runs.
    const fb = () =>
      env.DB.prepare("INSERT INTO review_routines (routine, version, updated_at, updated_by, fleet) VALUES (?, 1, ?, 'test', 'fb')")
        .bind(r, new Date().toISOString())
        .run();
    const db = interleaved(env.DB, /INSERT INTO review_routines \(routine, version, updated_at\) SELECT NULL/, fb);
    const res = await callWith(db, a, "POST", "/api/reviews/report", { stamp: stamp(0), result: "ok", report: reportOf([1]) });
    expect(res.status).toBe(403);
    const runs = await env.DB.prepare("SELECT count(*) AS n FROM review_runs WHERE routine = ?").bind(r).first<{ n: number }>();
    expect(runs!.n).toBe(0);
    expect((await env.DB.prepare("SELECT fleet, version FROM review_routines WHERE routine = ?").bind(r).first())).toEqual({ fleet: "fb", version: 1 });
  });
});
