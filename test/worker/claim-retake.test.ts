// docs/api.md "POST /api/items/:id/claim": a claim names the orchestrator session that made it (claimed_by, from
// X-Lease-Session) and when (claimed_at). An item left `processing` by a session that died or lost the lease can be
// claimed again by the session that holds the lease now; the session that claimed it can't (its parked items stay).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "../../worker/router.ts";
import { claimOp } from "../../worker/routes/items.ts";
import { getDoc } from "../../worker/store.ts";
import { call, createItem, human, mintToken, uid } from "./helpers.ts";

let token = "";
beforeAll(async () => {
  token = (await mintToken("manager", undefined, uid("mgr-retake"))).secret;
});

// The orchestrator's token on /agent, naming its session (or not).
const orch = (method: string, path: string, body?: unknown, session?: string) =>
  call(method, `/agent${path}`, { body, token, host: "inbox.test", headers: session === undefined ? {} : { "X-Lease-Session": session } });

// `session` takes the lease, from whoever holds it.
async function takeLease(session: string) {
  const cur = (await human.get("/api/lease")).body.lease;
  const r = await human.post("/api/lease/acquire", { session_id: session, force: true, if_version: cur?.version ?? 0 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function decided(): Promise<{ id: string; version: number }> {
  const id = uid("rt");
  await createItem(id);
  const d = await human.post(`/api/items/${id}/decide`, { choice: "ack" });
  expect(d.status).toBe(200);
  return { id, version: d.body.version };
}

describe("claim: who and when", () => {
  it("with X-Lease-Session it records the session and the time", async () => {
    await takeLease("s1");
    const { id, version } = await decided();
    const r = await orch("POST", `/api/items/${id}/claim`, { if_version: version }, "s1");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "processing", claimed_by: "s1", claimed_at: expect.any(String) });
    expect(r.body.data.claimed_at).toBe(r.body.data.updated_at);
  });

  it("without it, only the time (as before: nothing to re-take from)", async () => {
    const { id } = await decided();
    const r = await orch("POST", `/api/items/${id}/claim`, {});
    expect(r.status).toBe(200);
    expect(r.body.data.claimed_at).toEqual(expect.any(String));
    expect(r.body.data).not.toHaveProperty("claimed_by");
    // And no re-take without a session: 409 not_decided, as before.
    expect((await orch("POST", `/api/items/${id}/claim`, {})).body.error).toBe("not_decided");
  });
});

describe("claim: re-taking an item another session left processing", () => {
  it("the lease holder takes it, pinned; claimed_by moves and reclaimed_from keeps the session it came from", async () => {
    await takeLease("s1");
    const { id, version } = await decided();
    const first = await orch("POST", `/api/items/${id}/claim`, { if_version: version }, "s1");
    await takeLease("s2"); // s1 died or lost a takeover
    const stale = await orch("POST", `/api/items/${id}/claim`, { if_version: first.body.version - 1 }, "s2");
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("conflict");
    const r = await orch("POST", `/api/items/${id}/claim`, { if_version: first.body.version }, "s2");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "processing", claimed_by: "s2", reclaimed_from: "s1" });
    // s1 can't take it back: its writes are refused once it lost the lease.
    const back = await orch("POST", `/api/items/${id}/claim`, { if_version: r.body.version }, "s1");
    expect(back.status).toBe(409);
    expect(back.body.error).toBe("lease_held");
  });

  it("the session that claimed it gets 409 not_decided: an item it parked stays parked", async () => {
    await takeLease("s3");
    const { id, version } = await decided();
    const c = await orch("POST", `/api/items/${id}/claim`, { if_version: version }, "s3");
    const again = await orch("POST", `/api/items/${id}/claim`, { if_version: c.body.version }, "s3");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("not_decided");
  });

  it("an item claimed before claims were named (no claimed_by) can be re-taken; reclaimed_from is null", async () => {
    await takeLease("s4");
    const { id } = await decided();
    const legacy = await orch("POST", `/api/items/${id}/claim`, {});
    const r = await orch("POST", `/api/items/${id}/claim`, { if_version: legacy.body.version }, "s4");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ claimed_by: "s4", reclaimed_from: null });
  });

  it("a human's claim names no session and re-takes nothing, whatever header it sends", async () => {
    await takeLease("s5");
    const { id, version } = await decided();
    const c = await call("POST", `/api/items/${id}/claim`, { body: { if_version: version }, headers: { "X-Lease-Session": "s5" } });
    expect(c.status).toBe(200);
    expect(c.body.data).not.toHaveProperty("claimed_by");
    const again = await call("POST", `/api/items/${id}/claim`, { body: {}, headers: { "X-Lease-Session": "s5" } });
    expect(again.body.error).toBe("not_decided");
  });

  it("works in a batch: item.claim under the envelope's session", async () => {
    await takeLease("s6");
    const { id, version } = await decided();
    await orch("POST", `/api/items/${id}/claim`, { if_version: version }, "s6");
    await takeLease("s7");
    const cur = (await human.get(`/api/items/${id}`)).body;
    const r = await orch("POST", "/api/batch", { ops: [{ op: "item.claim", id, if_version: cur.version }] }, "s7");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results[0].data).toMatchObject({ claimed_by: "s7", reclaimed_from: "s6" });
  });

  it("an open or archived item still isn't claimable", async () => {
    await takeLease("s8");
    const id = uid("rt");
    await createItem(id);
    expect((await orch("POST", `/api/items/${id}/claim`, {}, "s8")).body.error).toBe("not_decided");
    await human.post(`/api/items/${id}/archive`);
    expect((await orch("POST", `/api/items/${id}/claim`, {}, "s8")).body.error).toBe("not_decided");
  });
});

describe("claim: the re-take is fenced on the lease when it's built", () => {
  // s1 passed the lease check on arrival, then paused; meanwhile s2 took the lease and re-took the item. When s1's
  // write is built, the item says s2 and so does the lease: s1 is refused, not handed the item back.
  it("a session that lost the lease after its request was checked can't re-take", async () => {
    await takeLease("s9");
    const { id, version } = await decided();
    await orch("POST", `/api/items/${id}/claim`, { if_version: version }, "s9");
    await takeLease("s10");
    const cur = (await getDoc<any>(env.DB, "items", id))!;
    const c = {
      caller: { principal: { kind: "token", name: "t", scope: "manager" }, actor: "token:t", bearer: true },
      request: new Request("https://inbox.test/", { headers: { "X-Lease-Session": "s9" } }),
      env, now: new Date().toISOString(), params: {}, url: new URL("https://inbox.test/"),
    } as unknown as Ctx;
    // The item as s10 left it after its own re-take: claimed_by s10.
    const retaken = { ...cur, data: { ...cur.data, claimed_by: "s10" } };
    await expect(Promise.resolve(claimOp(c, id, {}).build(retaken))).rejects.toMatchObject({ status: 409, code: "lease_held" });
  });
});

