// The GitHub hook decides from a fixed set of item fields whether a delivery closes an item and what it
// stamps (CLOSURE_FIELDS). An orchestrator token that didn't ask the question (the item's source isn't its
// id) may change none of them, so it can't steer a closure of someone else's question; on its own items
// it may, within the usual rules (status and decision stay the human's).
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hmacHex } from "../../worker/http.ts";
import { CLOSURE_FIELDS } from "../../worker/hooks/github.ts";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

const O = "O-cf";
let orch: ReturnType<typeof agent>;
beforeAll(async () => {
  orch = agent((await mintToken("orchestrator", O, "cf-token")).secret);
});

async function github(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await exports.default.fetch("https://inbox.test/hooks/github", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-Hub-Signature-256": `sha256=${await hmacHex(env.GITHUB_WEBHOOK_SECRET!, body)}` },
    body,
  });
  return (await res.json()) as any;
}
const pr = () => `https://github.com/acme/repo/pull/${Math.floor(Math.random() * 1e6)}`;
const closed = (url: string, merged: boolean) => github("pull_request", { action: "closed", pull_request: { html_url: url, merged } });
const get = async (id: string) => (await human.get(`/api/items/${id}`)).body;

// One change per closure field, and whether the asker itself may make it (status and decision are never a token's).
const CHANGE: Record<string, { value: unknown; owner: boolean }> = {
  close_on_pr: { value: true, owner: true },
  links: { value: [{ label: "PR", url: "https://github.com/acme/repo/pull/999999" }], owner: true },
  evidence: { value: [{ label: "CI", url: "https://ci.test/run/1" }], owner: true },
  type: { value: "pr_ready", owner: true },
  pr_state: { value: "merged", owner: true },
  status: { value: "decided", owner: false },
  decision: { value: { choice: "ack", decided_at: "2026-10-09T00:00:00.000Z" }, owner: false },
};

// Each way a token writes an item's fields.
const WRITES = {
  PUT: async (id: string, k: string, v: unknown) => orch.put(`/api/items/${id}`, { data: { ...(await get(id)).data, [k]: v } }),
  PATCH: (id: string, k: string, v: unknown) => orch.patch(`/api/items/${id}`, { data: { [k]: v } }),
  "answer data": (id: string, k: string, v: unknown) => orch.post(`/api/items/${id}/qa`, { text: "answer", data: { [k]: v } }),
  batch: (id: string, k: string, v: unknown) => orch.post("/api/batch", { ops: [{ op: "item.patch", id, data: { [k]: v } }] }),
} as const;

const item = async (source: string) => {
  const id = uid("cf");
  await createItem(id, { orchestrator: O, source, links: [{ label: "PR", url: pr() }] });
  return id;
};

describe("CLOSURE_FIELDS", () => {
  it("the table covers exactly the fields the hook reads", () => {
    expect(Object.keys(CHANGE).sort()).toEqual([...CLOSURE_FIELDS].sort());
  });

  const cases = CLOSURE_FIELDS.flatMap((f) => Object.keys(WRITES).map((w) => [f, w] as const));
  it.each(cases)("%s through %s: refused on a manager's item, as the asker only within the usual rules", async (field, how) => {
    const write = WRITES[how as keyof typeof WRITES];
    const { value, owner } = CHANGE[field];
    const theirs = await item(`sweep:${O}`);
    const before = await get(theirs);
    const r = await write(theirs, field, value);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect((await get(theirs)).version).toBe(before.version);

    const mine = await item(O);
    const m = await write(mine, field, value);
    expect(m.status, JSON.stringify(m.body)).toBe(owner ? (how === "answer data" ? 201 : 200) : 403);
  });
});

describe("repros", () => {
  it("a manager's flagged auto_decided item can't be retyped to decision and then closed over its decision", async () => {
    const url = pr();
    const id = uid("cf-auto");
    await createItem(id, {
      type: "auto_decided", orchestrator: O, source: `sweep:${O}`, close_on_pr: true, links: [{ label: "PR", url }],
      decision: { choice: "pin", decided_at: "2026-10-09T00:00:00.000Z" },
    });
    expect((await orch.patch(`/api/items/${id}`, { data: { type: "decision" } })).status).toBe(403);
    await closed(url, false);
    expect((await get(id)).data).toMatchObject({ type: "auto_decided", status: "open", decision: { choice: "pin" } });
  });

  it("a manager's flagged decision can't be retyped to auto_decided to keep it from closing", async () => {
    const url = pr();
    const id = uid("cf-dec");
    await createItem(id, { orchestrator: O, source: `sweep:${O}`, close_on_pr: true, links: [{ label: "PR", url }] });
    expect((await orch.patch(`/api/items/${id}`, { data: { type: "auto_decided" } })).status).toBe(403);
    await closed(url, true);
    expect((await get(id)).data).toMatchObject({ status: "archived", decision: { ended: "merged" } });
  });

  it("a manager's flagged item can't be kept open by a token writing pr_state: merged first", async () => {
    const url = pr();
    const id = uid("cf-pr");
    await createItem(id, { orchestrator: O, source: `sweep:${O}`, close_on_pr: true, links: [{ label: "PR", url }] });
    expect((await orch.patch(`/api/items/${id}`, { data: { pr_state: "merged" } })).status).toBe(403);
  });

  it.each([
    ["merged", "merged", true],
    ["merged", "closed", false],
    ["closed", "merged", true],
    ["closed", "closed", false],
  ])("an open flagged item whose pr_state is already %s still closes on a signed %s delivery", async (pre, _, merged) => {
    const url = pr();
    const id = uid("cf-pre");
    await createItem(id, { orchestrator: O, source: O, close_on_pr: true, links: [{ label: "PR", url }], pr_state: pre as "merged" });
    const r = await closed(url, merged);
    expect(r.updated).toEqual([{ collection: "items", id }]);
    const doc = await get(id);
    expect(doc.data.status).toBe("archived");
    expect(doc.data.decision).toMatchObject({ ended: merged ? "merged" : "closed", by: "hook:github" });
    // pr_state keeps its own rule: merged is terminal.
    expect(doc.data.pr_state).toBe(pre === "merged" ? "merged" : merged ? "merged" : "closed");
  });

  it("an open pr_ready item whose pr_state is already merged is archived by the merge delivery", async () => {
    const url = pr();
    const id = uid("cf-ready");
    await createItem(id, { type: "pr_ready", links: [{ label: "PR", url }], pr_state: "merged" });
    await closed(url, true);
    expect((await get(id)).data).toMatchObject({ status: "archived", decision: { ended: "merged" } });
  });

  it("a delivery that neither moves pr_state nor closes anything writes nothing", async () => {
    const url = pr();
    const id = uid("cf-noop");
    await createItem(id, { links: [{ label: "PR", url }], pr_state: "merged" });
    const v = (await get(id)).version;
    expect((await closed(url, false)).updated).toEqual([]);
    expect((await get(id)).version).toBe(v);
  });
});

describe("legitimate flows still pass", () => {
  it("the routine's own flagged item: posted, answered, re-linked, closed on merge", async () => {
    const first = pr(), second = pr();
    const id = uid("cf-own");
    const c = await orch.put(`/api/items/${id}`, {
      data: { type: "decision", title: "hold", orchestrator: O, source: O, close_on_pr: true, links: [{ label: "PR", url: first }] },
      if_version: 0,
    });
    expect(c.status).toBe(201);
    await human.post(`/api/items/${id}/qa`, { text: "why?" });
    expect((await orch.post(`/api/items/${id}/qa`, { text: "because", data: { links: [{ label: "PR", url: second }] } })).status).toBe(201);
    await closed(second, true);
    expect((await get(id)).data).toMatchObject({ status: "archived", decision: { ended: "merged" } });
  });

  it("on a manager's item a token still edits the briefing and answers; the manager edits anything", async () => {
    const id = await item(`sweep:${O}`);
    expect((await orch.patch(`/api/items/${id}`, { data: { summary: "s", question: "q?" } })).status).toBe(200);
    await human.post(`/api/items/${id}/qa`, { text: "why?" });
    expect((await orch.post(`/api/items/${id}/qa`, { text: "because", data: { context: "more" } })).status).toBe(201);
    const manager = agent((await mintToken("manager", undefined, "cf-mgr")).secret);
    expect((await manager.patch(`/api/items/${id}`, { data: { type: "pr_ready", close_on_pr: true, pr_state: "open" } })).status).toBe(200);
  });

  it("a token may still post a new item with links and a type, whatever its source", async () => {
    const r = await orch.put(`/api/items/${uid("cf-new")}`, {
      data: { type: "blocker", title: "stuck", orchestrator: O, links: [{ label: "PR", url: pr() }] },
      if_version: 0,
    });
    expect(r.status).toBe(201);
  });
});
