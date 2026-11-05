// POST /api/items/:id/snooze: a human hides an open item from their own Inbox until a time. Snoozes are
// per person (the snoozes table, migration 0007) and never touch the item doc.
import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signDecide } from "../../worker/hooks/ntfy.ts";
import worker from "../../worker/index.ts";
import { agent, createItem, human, mintToken, person, setRoles, uid } from "./helpers.ts";

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3600_000, DAY = 24 * HOUR;
const A = person("a@team.test"), B = person("b@team.test");

const mySnoozes = async (who: ReturnType<typeof person>) => {
  const r = await who.get("/api/state");
  expect(r.status).toBe(200);
  return r.body.snoozes as Record<string, string>;
};
const rows = async (id: string) =>
  (await env.DB.prepare("SELECT email, until FROM snoozes WHERE item_id = ? ORDER BY email").bind(id).all()).results;
const seq = async () => (await env.DB.prepare("SELECT coalesce(max(seq), 0) AS s FROM changes").first<{ s: number }>())!.s;

describe("POST /api/items/:id/snooze", () => {
  it("stores the caller's snooze (normalized) and leaves the item doc untouched", async () => {
    const id = uid("snz");
    const doc = await createItem(id);
    const until = new Date(Date.now() + 2 * HOUR);
    until.setUTCMilliseconds(0);
    const r = await A.post(`/api/items/${id}/snooze`, { until: until.toISOString().replace(".000Z", "Z") });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ item_id: id, until: until.toISOString() });
    expect(await rows(id)).toEqual([{ email: "a@team.test", until: until.toISOString() }]);
    const after = (await human.get(`/api/items/${id}`)).body;
    expect(after.version).toBe(doc.version);
    expect(after.updated_at).toBe(doc.updated_at);
    expect(after.data).toEqual(doc.data);
  });

  it("is per person: A's snooze doesn't hide the item from B", async () => {
    const id = uid("snz");
    await createItem(id);
    const untilA = inMs(HOUR), untilB = inMs(3 * HOUR);
    expect((await A.post(`/api/items/${id}/snooze`, { until: untilA })).status).toBe(200);
    expect((await mySnoozes(A))[id]).toBe(untilA);
    expect(await mySnoozes(B)).not.toHaveProperty(id);
    expect((await B.post(`/api/items/${id}/snooze`, { until: untilB })).status).toBe(200);
    expect((await mySnoozes(B))[id]).toBe(untilB);
    expect((await mySnoozes(A))[id]).toBe(untilA);
    // A wakes it: only A's row goes.
    expect((await A.post(`/api/items/${id}/snooze`, { until: null })).status).toBe(200);
    expect(await mySnoozes(A)).not.toHaveProperty(id);
    expect((await mySnoozes(B))[id]).toBe(untilB);
  });

  it("matches the caller's email case-insensitively", async () => {
    const id = uid("snz");
    await createItem(id);
    const until = inMs(HOUR);
    expect((await person("Mixed@Team.test").post(`/api/items/${id}/snooze`, { until })).status).toBe(200);
    expect(await rows(id)).toEqual([{ email: "mixed@team.test", until }]);
    expect((await mySnoozes(person("mixed@team.test")))[id]).toBe(until);
  });

  it("a re-snooze moves the time", async () => {
    const id = uid("snz");
    await createItem(id);
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    const later = inMs(5 * HOUR);
    expect((await A.post(`/api/items/${id}/snooze`, { until: later })).status).toBe(200);
    expect(await rows(id)).toEqual([{ email: "a@team.test", until: later }]);
  });

  it("an ntfy link signed before someone snoozed still decides (the version didn't move)", async () => {
    const id = uid("snz");
    const doc = await createItem(id, { type: "proposal" });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = await signDecide(env.NTFY_ACTION_SECRET!, id, "approve", exp, doc.created_at!, doc.version);
    expect((await B.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) })).status).toBe(200);
    const q = new URLSearchParams({ item: id, choice: "approve", exp: String(exp), created: doc.created_at!, ver: String(doc.version), sig });
    const res = await exports.default.fetch(`https://inbox.test/hooks/ntfy/decide?${q}`, { method: "POST" });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { ok: true, status: "decided" } });
  });

  it("a page pinned on the version before the snooze still decides", async () => {
    const id = uid("snz");
    const doc = await createItem(id);
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    const d = await B.post(`/api/items/${id}/decide`, { choice: "ack", if_version: doc.version });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
  });

  it("accepts and ignores if_version (older pages send it)", async () => {
    const id = uid("snz");
    const doc = await createItem(id);
    const r = await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR), if_version: doc.version + 5 });
    expect(r.status).toBe(200);
  });

  it("takes a time in the future, at most 30 days out, or null", async () => {
    const id = uid("snz");
    await createItem(id);
    for (const until of [inMs(-60_000), inMs(31 * DAY), "tomorrow", 1234, "", undefined]) {
      const r = await A.post(`/api/items/${id}/snooze`, { until });
      expect(r.status, String(until)).toBe(400);
    }
    expect(await rows(id)).toEqual([]);
    expect((await A.post(`/api/items/${id}/snooze`, { until: inMs(29 * DAY) })).status).toBe(200);
  });

  it("snoozes only an open item (409 not_open with current), but unsnoozes any", async () => {
    const id = uid("snz");
    const doc = await createItem(id);
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    expect((await human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: doc.version })).status).toBe(200);
    const again = await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("not_open");
    expect(again.body.current.data.status).toBe("decided");
    const clear = await A.post(`/api/items/${id}/snooze`, { until: null });
    expect(clear.status).toBe(200);
    expect(clear.body).toEqual({ item_id: id, until: null });
    expect(await rows(id)).toEqual([]);
  });

  it("a missing item is 404 to snooze, and unsnoozing one is a no-op", async () => {
    const id = uid("nope");
    expect((await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) })).status).toBe(404);
    expect((await A.post(`/api/items/${id}/snooze`, { until: null })).status).toBe(200);
    expect(await rows(id)).toEqual([]);
  });

  it("is for humans only: manager and orchestrator tokens get 403", async () => {
    const id = uid("snz");
    await createItem(id, { orchestrator: "O9" });
    const mgr = await mintToken("manager");
    const orch = await mintToken("orchestrator", "O9");
    for (const t of [mgr.secret, orch.secret]) {
      const r = await agent(t).post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
      expect(r.status).toBe(403);
    }
    expect(await rows(id)).toEqual([]);
  });

  it("is a decider's: a viewer gets 403", async () => {
    const id = uid("snz");
    await createItem(id);
    await setRoles({ "you@test": "admin", "viewer@team.test": "viewer" });
    try {
      const r = await person("viewer@team.test").post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
      expect(r.status).toBe(403);
    } finally {
      await env.DB.prepare("DELETE FROM users").run();
    }
  });

  it("is not batchable", async () => {
    const id = uid("snz");
    await createItem(id);
    const r = await human.post("/api/batch", { ops: [{ op: "item.snooze", id, until: inMs(HOUR) }] });
    expect(r.status).toBe(400);
  });

  it("deleting the item drops everyone's snoozes on it", async () => {
    const id = uid("snz");
    await createItem(id);
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    await B.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    expect((await human.del(`/api/items/${id}`)).status).toBe(200);
    expect(await rows(id)).toEqual([]);
  });
});

describe("/api/state snoozes", () => {
  it("holds only the caller's snoozes still in the future", async () => {
    const live = uid("snz"), gone = uid("snz");
    await createItem(live);
    await createItem(gone);
    const until = inMs(HOUR);
    await A.post(`/api/items/${live}/snooze`, { until });
    await A.post(`/api/items/${gone}/snooze`, { until: inMs(HOUR) });
    await env.DB.prepare("UPDATE snoozes SET until = ? WHERE item_id = ?").bind(inMs(-HOUR), gone).run();
    const s = await mySnoozes(A);
    expect(s[live]).toBe(until);
    expect(s).not.toHaveProperty(gone);
  });

  it("is empty for tokens", async () => {
    const id = uid("snz");
    await createItem(id, { orchestrator: "O7" });
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    for (const t of [(await mintToken("manager")).secret, (await mintToken("orchestrator", "O7")).secret]) {
      const r = await agent(t).get("/api/state");
      expect(r.status).toBe(200);
      expect(r.body.snoozes).toEqual({});
    }
  });
});

describe("snoozes in the change log", () => {
  it("logs each snooze write as collection snoozes, doc_id the item, actor the snoozer, seen only by them", async () => {
    const id = uid("snz");
    await createItem(id, { orchestrator: "O6" });
    const since = await seq();
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    await A.post(`/api/items/${id}/snooze`, { until: inMs(2 * HOUR) });
    await A.post(`/api/items/${id}/snooze`, { until: null });
    const mine = (await A.get(`/api/changes?since=${since}`)).body.changes;
    expect(mine.map((c: any) => [c.collection, c.doc_id, c.op, c.actor])).toEqual([
      ["snoozes", id, "create", "human:a@team.test"],
      ["snoozes", id, "update", "human:a@team.test"],
      ["snoozes", id, "delete", "human:a@team.test"],
    ]);
    // Nobody else's feed (or wait loop) sees them: other humans, the manager, orchestrator tokens.
    expect((await B.get(`/api/changes?since=${since}`)).body.changes).toEqual([]);
    for (const t of [(await mintToken("manager")).secret, (await mintToken("orchestrator", "O6")).secret]) {
      const r = await agent(t).get(`/api/changes?since=${since}`);
      expect(r.status).toBe(200);
      expect(r.body.changes.filter((c: any) => c.collection === "snoozes")).toEqual([]);
    }
  });
});

describe("other writes can't snooze or wake", () => {
  it("a create ignores snooze fields in the body", async () => {
    const id = uid("snz");
    const r = await human.put(`/api/items/${id}`, { data: { type: "decision", title: "x", snoozed_until: inMs(HOUR), snoozed_by: "human:x@y" } });
    expect(r.status).toBe(201);
    expect(r.body.data).not.toHaveProperty("snoozed_until");
    expect(r.body.data).not.toHaveProperty("snoozed_by");
    expect(await rows(id)).toEqual([]);
  });

  it("a PATCH or a qa answer ignores them too, and leaves the snoozer's row alone", async () => {
    const id = uid("snz");
    await createItem(id, { orchestrator: "O8" });
    const until = inMs(HOUR);
    await A.post(`/api/items/${id}/snooze`, { until });
    const orch = await mintToken("orchestrator", "O8");
    const p = await agent(orch.secret).patch(`/api/items/${id}`, { data: { snoozed_until: inMs(DAY), snoozed_by: "token:x", summary: "more" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.summary).toBe("more");
    expect(p.body.data).not.toHaveProperty("snoozed_until");
    const mgr = await mintToken("manager");
    const q = await agent(mgr.secret).post(`/api/items/${id}/qa`, { text: "answer", data: { snoozed_until: inMs(2 * DAY) } });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.item.data).not.toHaveProperty("snoozed_until");
    expect(await rows(id)).toEqual([{ email: "a@team.test", until }]);
  });
});

describe("items still carrying a snooze from before (migration 0007)", () => {
  async function legacyDecided(orchestrator: string) {
    const id = uid("old");
    const data = {
      type: "decision", title: "old", status: "decided", orchestrator,
      decision: { choice: "ack", decided_at: "2026-10-01T00:00:00.000Z", by: "human:a@team.test" },
      snoozed_until: inMs(HOUR), snoozed_by: "human:a@team.test",
    };
    const at = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO docs (collection, id, data, version, created_at, updated_at, updated_by) VALUES ('items', ?, ?, 3, ?, ?, 'human:a@team.test')",
    ).bind(id, JSON.stringify(data), at, at).run();
    return id;
  }

  it("an orchestrator token can still write what it may on its decided item, and the old fields go", async () => {
    const id = await legacyDecided("O5");
    const orch = await mintToken("orchestrator", "O5");
    const p = await agent(orch.secret).patch(`/api/items/${id}`, { data: { assignee: "x@team.test" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data).not.toHaveProperty("snoozed_until");
    expect(p.body.data).not.toHaveProperty("snoozed_by");
    const id2 = await legacyDecided("O5");
    const q = await agent(orch.secret).post(`/api/items/${id2}/qa`, { text: "answer" });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.item.data).not.toHaveProperty("snoozed_until");
  });
});

describe("snooze pruning (cron)", () => {
  it("deletes expired snoozes and those on items no longer open, keeping live ones", async () => {
    const live = uid("snz"), expired = uid("snz"), decided = uid("snz");
    for (const id of [live, expired, decided]) {
      const doc = await createItem(id);
      await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
      if (id === decided) await human.post(`/api/items/${id}/decide`, { choice: "ack", if_version: doc.version });
    }
    await env.DB.prepare("UPDATE snoozes SET until = ? WHERE item_id = ?").bind(inMs(-HOUR), expired).run();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "17 4 * * *" }), env);
    expect((await rows(live)).length).toBe(1);
    expect(await rows(expired)).toEqual([]);
    expect(await rows(decided)).toEqual([]);
  });

  it("still runs when the change-log retention setting is invalid", async () => {
    const id = uid("snz");
    await createItem(id);
    await A.post(`/api/items/${id}/snooze`, { until: inMs(HOUR) });
    await env.DB.prepare("UPDATE snoozes SET until = ? WHERE item_id = ?").bind(inMs(-HOUR), id).run();
    const run = worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "17 4 * * *" }), { ...env, CHANGES_RETENTION_DAYS: "2" });
    await expect(run).rejects.toThrow(/CHANGES_RETENTION_DAYS/);
    expect(await rows(id)).toEqual([]);
  });
});
