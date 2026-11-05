// Which ntfy topics a push goes to: the assignee's own topic when set, else
// every person's topic plus NTFY_TOPIC; never a viewer's, since the pushes
// carry decide buttons. Own file: the users table is per-D1.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signDecide } from "../../worker/hooks/ntfy.ts";
import worker from "../../worker/index.ts";
import { clearUsers, mintToken, setPeople, uid } from "./helpers.ts";

let sent: { topic: string; title: string; actions: any[] }[] = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
});
afterEach(() => vi.restoreAllMocks());

async function send(vars: Record<string, string | undefined>, method: string, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://${token ? "inbox.test" : "localhost"}${path}`, { method, headers, body: JSON.stringify(body) }),
    { ...env, ...vars },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as any };
}

// A lock-screen button tap: the hook itself, not the mocked ntfy publish.
async function tap(url: string) {
  const res = await worker.fetch(new Request(url, { method: "POST" }), env, createExecutionContext());
  return { status: res.status, body: (await res.json()) as any };
}

const GLOBAL = { NTFY_TOPIC: "global-topic" };
const propose = (vars: Record<string, string | undefined>, data: Record<string, unknown> = {}) =>
  send(vars, "PUT", `/api/items/${uid("n")}`, { data: { type: "proposal", title: "Do X", ...data } });
const topics = () => sent.map((m) => m.topic).sort();

describe("ntfy routing", () => {
  const noPeople = clearUsers;

  it("without people every push goes to NTFY_TOPIC, assigned or not (today's behavior)", async () => {
    await noPeople();
    await propose(GLOBAL);
    await propose(GLOBAL, { assignee: "alice@example.com" });
    expect(sent.map((m) => m.topic)).toEqual(["global-topic", "global-topic"]);
  });

  it("no topics anywhere: nothing is published", async () => {
    await noPeople();
    expect((await propose({ NTFY_TOPIC: undefined })).status).toBe(201);
    expect(sent).toEqual([]);
  });

  describe("with people", () => {
    beforeEach(() =>
      setPeople({
        "alice@example.com": { name: "Alice", ntfy_topic: "alice-topic" },
        "bob@example.com": { ntfy_topic: "global-topic" }, // same as NTFY_TOPIC: deduped
        "carol@example.com": { name: "Carol" }, // no topic
      }),
    );

    it("an unassigned item goes to every person's topic plus NTFY_TOPIC, once each, with the same signed actions", async () => {
      const r = await propose(GLOBAL);
      expect(topics()).toEqual(["alice-topic", "global-topic"]);
      expect(sent[0].actions).toEqual(sent[1].actions);
      const approve = new URL(sent[0].actions.find((a: any) => a.label === "Approve").url);
      const exp = Number(approve.searchParams.get("exp"));
      expect(approve.searchParams.get("sig")).toBe(
        await signDecide(env.NTFY_ACTION_SECRET!, r.body.id, "approve", exp, r.body.created_at, 1),
      );
    });

    it("viewers' topics are left out, and a viewer assignee counts as having none", async () => {
      await setPeople({
        "alice@example.com": { name: "Alice", ntfy_topic: "alice-topic", role: "decider" },
        "vic@example.com": { ntfy_topic: "vic-topic", role: "viewer" },
      });
      await propose(GLOBAL);
      await propose(GLOBAL, { assignee: "vic@example.com" });
      expect(topics()).toEqual(["alice-topic", "alice-topic", "global-topic", "global-topic"]);
    });

    it("unassigned without NTFY_TOPIC: only the people's topics", async () => {
      await propose({ NTFY_TOPIC: undefined });
      expect(topics()).toEqual(["alice-topic", "global-topic"]);
    });

    it("an assigned item goes only to the assignee's topic", async () => {
      await propose(GLOBAL, { assignee: "Alice@example.com" });
      expect(topics()).toEqual(["alice-topic"]);
    });

    it("an assignee without a topic, or unknown, falls back to everyone", async () => {
      await propose(GLOBAL, { assignee: "carol@example.com" });
      await propose(GLOBAL, { assignee: "dave@example.com" });
      expect(topics()).toEqual(["alice-topic", "alice-topic", "global-topic", "global-topic"]);
    });

    it("answers follow the item's assignee", async () => {
      const id = uid("n");
      await send({}, "PUT", `/api/items/${id}`, { data: { type: "info", title: "q", assignee: "alice@example.com" } });
      const manager = (await mintToken("manager", undefined, uid("mgr"))).secret;
      const r = await send(GLOBAL, "POST", `/agent/api/items/${id}/qa`, { text: "because" }, manager);
      expect(r.status).toBe(201);
      expect(sent.map((m) => [m.topic, m.title])).toEqual([["alice-topic", "Answer: q"]]);
    });

    // Item 4 of the decision-binding fix: an answer that changes the briefing
    // bumps the version, so the buttons pushed before it stop working.
    it("an answer that changes the briefing retires earlier buttons; its own push carries fresh ones", async () => {
      const created = await propose(GLOBAL, { assignee: "alice@example.com" });
      const id = created.body.id;
      const oldApprove = sent[0].actions.find((a: any) => a.label === "Approve").url;
      sent = [];
      const manager = (await mintToken("manager", undefined, uid("mgr"))).secret;
      const r = await send(GLOBAL, "POST", `/agent/api/items/${id}/qa`, {
        text: "Changed my mind",
        data: { title: "Do Y", options: [{ id: "approve", label: "Ship Y" }, { id: "reject", label: "Reject" }] },
      }, manager);
      expect(r.status).toBe(201);
      expect(r.body.item.version).toBe(2);

      expect(await tap(oldApprove)).toMatchObject({ status: 409, body: { error: "conflict" } });
      expect((await send({}, "GET", `/api/items/${id}`, undefined)).body.data.status).toBe("open");

      expect(sent.map((m) => [m.topic, m.title])).toEqual([["alice-topic", "Answer: Do Y"]]);
      const fresh = sent[0].actions.find((a: any) => a.label === "Ship Y").url;
      expect(new URL(fresh).searchParams.get("ver")).toBe("2");
      expect(await tap(fresh)).toMatchObject({ status: 200, body: { ok: true, status: "decided" } });
    });

    it("answers on an item that is no longer open, or isn't an ask, carry no decide buttons", async () => {
      const created = await propose(GLOBAL, { assignee: "alice@example.com" });
      await send({}, "POST", `/api/items/${created.body.id}/decide`, { choice: "approve" });
      const auto = await propose({}, {
        type: "auto_decided",
        assignee: "alice@example.com",
        options: [{ id: "a", label: "A" }],
        decision: { choice: "a", decided_at: "2026-10-07T00:00:00Z" },
      });
      sent = [];
      const manager = (await mintToken("manager", undefined, uid("mgr"))).secret;
      await send(GLOBAL, "POST", `/agent/api/items/${created.body.id}/qa`, { text: "noted" }, manager);
      await send(GLOBAL, "POST", `/agent/api/items/${auto.body.id}/qa`, { text: "fyi" }, manager);
      expect(sent.map((m) => m.actions.map((a: any) => a.label))).toEqual([["Open"], ["Open"]]);
    });

    describe("reassigning", () => {
      // Created without NTFY_TOPIC or an assignee topic in reach, so only the reassign can push.
      const ask = async (data: Record<string, unknown> = {}) =>
        (await send({}, "PUT", `/api/items/${uid("r")}`, { data: { type: "proposal", title: "Do X", ...data } })).body;
      const reassign = (id: string, data: Record<string, unknown>) => send(GLOBAL, "PATCH", `/api/items/${id}`, { data });
      const clear = () => (sent = []);

      it("an open ask reassigned to someone pushes to their topic alone, with the signed actions", async () => {
        const doc = await ask();
        clear();
        expect((await reassign(doc.id, { assignee: "alice@example.com" })).status).toBe(200);
        expect(sent.map((m) => [m.topic, m.title])).toEqual([["alice-topic", "Assigned to you: Do X"]]);
        const approve = new URL(sent[0].actions.find((a: any) => a.label === "Approve").url);
        const exp = Number(approve.searchParams.get("exp"));
        // Signed for the version the reassign wrote, which is what the push shows.
        expect(approve.searchParams.get("ver")).toBe("2");
        expect(approve.searchParams.get("sig")).toBe(
          await signDecide(env.NTFY_ACTION_SECRET!, doc.id, "approve", exp, doc.created_at, 2),
        );
        expect(await tap(approve.toString())).toMatchObject({ status: 200 });
      });

      it("no push when the assignee doesn't change, has no topic, or the item isn't an open ask", async () => {
        const assigned = await ask({ assignee: "alice@example.com" });
        const info = await ask({ type: "info" });
        const decided = await ask();
        await send({}, "POST", `/api/items/${decided.id}/decide`, { choice: "approve" });
        clear();
        await reassign(assigned.id, { summary: "s" });
        await reassign(assigned.id, { assignee: "carol@example.com" });
        await reassign(info.id, { assignee: "alice@example.com" });
        await reassign(decided.id, { assignee: "alice@example.com" });
        await reassign(assigned.id, { assignee: null });
        expect(sent).toEqual([]);
      });

      it("a viewer assignee gets no push: it would carry decide buttons", async () => {
        const doc = await ask();
        const manager = (await mintToken("manager", undefined, uid("mgr"))).secret;
        await setPeople({
          "boss@example.com": { role: "admin", ntfy_topic: "boss-topic" },
          "vic@example.com": { role: "viewer", ntfy_topic: "vic-topic" },
        });
        clear();
        // you@test is a viewer now too (an admin is saved): the manager reassigns.
        expect((await reassign(doc.id, { assignee: "vic@example.com" })).status).toBe(403);
        const r = await send(GLOBAL, "PATCH", `/agent/api/items/${doc.id}`, { data: { assignee: "vic@example.com" } }, manager);
        expect(r.status).toBe(200);
        expect(sent).toEqual([]);
      });

      it("assigning yourself doesn't push to yourself", async () => {
        await setPeople({ "you@test": { ntfy_topic: "you-topic" } });
        const doc = await ask();
        clear();
        await reassign(doc.id, { assignee: "you@test" });
        expect(sent).toEqual([]);
      });
    });
  });
});
