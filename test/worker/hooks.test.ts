import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hmacHex } from "../../worker/http.ts";
import { signDecide } from "../../worker/hooks/ntfy.ts";
import worker from "../../worker/index.ts";
import { agent, createItem, human, mintToken, uid } from "./helpers.ts";

async function github(event: string, payload: unknown, secret = env.GITHUB_WEBHOOK_SECRET!) {
  const body = JSON.stringify(payload);
  const res = await exports.default.fetch("https://inbox.test/hooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": `sha256=${await hmacHex(secret, body)}`,
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("GitHub hook", () => {
  it("rejects a bad signature", async () => {
    const r = await github("pull_request", { action: "closed" }, "wrong");
    expect(r.status).toBe(401);
    const unsigned = await exports.default.fetch("https://inbox.test/hooks/github", { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(401);
  });

  it("ignores other events", async () => {
    expect(await github("push", { ref: "main" })).toEqual({ status: 202, body: { ignored: true } });
    expect((await github("pull_request", { action: "opened", pull_request: { html_url: "https://x" } })).status).toBe(202);
  });

  it("a merged PR archives an open pr_ready item and sets the orchestrator's pr.state", async () => {
    const n = Math.floor(Math.random() * 1e6);
    const url = `https://github.com/acme/repo/pull/${n}`;
    const ready = uid("pr");
    const decision = uid("dec");
    const unrelated = uid("other");
    await createItem(ready, { type: "pr_ready", links: [{ label: "PR", url }] });
    await createItem(decision, { evidence: [{ label: "files", url: `${url}/files` }] });
    await createItem(unrelated, { type: "pr_ready", links: [{ label: "PR", url: `${url}0` }] });
    const o = uid("O");
    await human.put(`/api/orchestrators/${o}`, { data: { pr: { number: n, url } } });

    const r = await github("pull_request", { action: "closed", pull_request: { html_url: url, merged: true } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual(
      expect.arrayContaining([
        { collection: "items", id: ready },
        { collection: "items", id: decision },
        { collection: "orchestrators", id: o },
      ]),
    );
    expect(r.body.updated).toHaveLength(3);

    const item = (await human.get(`/api/items/${ready}`)).body;
    expect(item.updated_by).toBe("hook:github");
    expect(item.data).toMatchObject({
      status: "archived",
      pr_state: "merged",
      decision: { choice: "merged", ended: "merged", note: "Merged on GitHub", by: "hook:github" },
    });
    expect((await human.get(`/api/items/${decision}`)).body.data).toMatchObject({ status: "open", pr_state: "merged" });
    expect((await human.get(`/api/items/${unrelated}`)).body.data.pr_state).toBeUndefined();
    expect((await human.get(`/api/orchestrators/${o}`)).body.data.pr).toEqual({ number: n, url, state: "merged" });
  });

  it("reviews set pr_state from review.state", async () => {
    const url = `https://github.com/acme/repo/pull/${Math.floor(Math.random() * 1e6)}`;
    const id = uid("rev");
    await createItem(id, { type: "pr_ready", links: [{ label: "PR", url }] });
    const r = await github("pull_request_review", {
      action: "submitted",
      review: { state: "CHANGES_REQUESTED" },
      pull_request: { html_url: url },
    });
    expect(r.body.updated).toEqual([{ collection: "items", id }]);
    expect((await human.get(`/api/items/${id}`)).body.data).toMatchObject({ status: "open", pr_state: "changes_requested" });
  });

  it("a review after the merge, or a replayed close, doesn't move a merged PR back", async () => {
    const n = Math.floor(Math.random() * 1e6);
    const url = `https://github.com/acme/repo/pull/${n}`;
    const id = uid("late");
    await createItem(id, { type: "pr_ready", links: [{ label: "PR", url }] });
    const o = uid("O");
    await human.put(`/api/orchestrators/${o}`, { data: { pr: { number: n, url } } });
    await github("pull_request", { action: "closed", pull_request: { html_url: url, merged: true } });

    const late = await github("pull_request_review", {
      action: "submitted",
      review: { state: "commented" },
      pull_request: { html_url: url },
    });
    expect(late.body.updated).toEqual([]);
    const replay = await github("pull_request", { action: "closed", pull_request: { html_url: url, merged: false } });
    expect(replay.body.updated).toEqual([]);
    expect((await human.get(`/api/items/${id}`)).body.data).toMatchObject({ status: "archived", pr_state: "merged" });
    expect((await human.get(`/api/orchestrators/${o}`)).body.data.pr.state).toBe("merged");
  });

  it("a closed PR ignores reviews but can still be merged (closed, reopened, merged)", async () => {
    const n = Math.floor(Math.random() * 1e6);
    const url = `https://github.com/acme/repo/pull/${n}`;
    const id = uid("closed");
    await createItem(id, { type: "pr_ready", links: [{ label: "PR", url }] });
    const o = uid("O");
    await human.put(`/api/orchestrators/${o}`, { data: { pr: { number: n, url } } });
    await github("pull_request", { action: "closed", pull_request: { html_url: url, merged: false } });

    const review = await github("pull_request_review", {
      action: "submitted",
      review: { state: "APPROVED" },
      pull_request: { html_url: url },
    });
    expect(review.body.updated).toEqual([]);
    expect((await human.get(`/api/items/${id}`)).body.data).toMatchObject({ status: "open", pr_state: "closed" });
    expect((await human.get(`/api/orchestrators/${o}`)).body.data.pr.state).toBe("closed");

    const merged = await github("pull_request", { action: "closed", pull_request: { html_url: url, merged: true } });
    expect(merged.body.updated).toHaveLength(2);
    expect((await human.get(`/api/items/${id}`)).body.data).toMatchObject({ status: "archived", pr_state: "merged" });
    expect((await human.get(`/api/orchestrators/${o}`)).body.data.pr.state).toBe("merged");
  });

  it("503 when the secret isn't set", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://inbox.test/hooks/github", { method: "POST", body: "{}" }),
      { ...env, GITHUB_WEBHOOK_SECRET: undefined },
      ctx,
    );
    expect(res.status).toBe(503);
  });
});

// An item posted with close_on_pr: true asks a question about its linked PR,
// so the question ends with the PR: a merge or a close archives it while it is
// still open. Nothing else does.
describe("GitHub hook: close_on_pr items", () => {
  const pr = () => `https://github.com/acme/repo/pull/${Math.floor(Math.random() * 1e6)}`;
  const closed = (url: string, merged: boolean) =>
    github("pull_request", { action: "closed", pull_request: { html_url: url, merged } });
  const ask = async (url: string, data: Record<string, unknown> = {}) => {
    const id = uid("cop");
    await createItem(id, { close_on_pr: true, links: [{ label: "PR", url }], ...data });
    return id;
  };
  const item = async (id: string) => (await human.get(`/api/items/${id}`)).body;

  it("a merge archives an open one with decision merged", async () => {
    const url = pr();
    const id = await ask(url);
    const r = await closed(url, true);
    expect(r.body.updated).toEqual([{ collection: "items", id }]);
    const doc = await item(id);
    expect(doc.updated_by).toBe("hook:github");
    expect(doc.data).toMatchObject({ status: "archived", pr_state: "merged" });
    expect(doc.data.decision).toEqual({ choice: "merged", ended: "merged", note: "Merged on GitHub", decided_at: doc.updated_at, by: "hook:github" });
  });

  it("a close without a merge archives an open one with decision closed", async () => {
    const url = pr();
    const id = await ask(url, { links: [{ label: "files", url: `${url}/files` }] });
    await closed(url, false);
    const doc = await item(id);
    expect(doc.data).toMatchObject({ status: "archived", pr_state: "closed" });
    expect(doc.data.decision).toEqual({
      choice: "closed",
      ended: "closed",
      note: "Closed on GitHub without merging",
      decided_at: doc.updated_at,
      by: "hook:github",
    });
  });

  it.each(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"])("a %s review leaves it open", async (state) => {
    const url = pr();
    const id = await ask(url);
    await github("pull_request_review", { action: "submitted", review: { state }, pull_request: { html_url: url } });
    const doc = await item(id);
    expect(doc.data.status).toBe("open");
    expect(doc.data.decision).toBeUndefined();
  });

  it("a decided one keeps the human's decision: the merge only sets pr_state", async () => {
    const url = pr();
    const id = await ask(url);
    await human.post(`/api/items/${id}/decide`, { choice: "ack", note: "do it" });
    await closed(url, true);
    const doc = await item(id);
    expect(doc.data).toMatchObject({ status: "decided", pr_state: "merged", decision: { choice: "ack", note: "do it" } });
  });

  it("without the flag, an open decision item stays open when its PR closes or merges", async () => {
    const url = pr();
    const id = uid("plain");
    await createItem(id, { links: [{ label: "PR", url }] });
    await closed(url, false);
    expect((await item(id)).data).toMatchObject({ status: "open", pr_state: "closed" });
    await closed(url, true);
    expect((await item(id)).data).toMatchObject({ status: "open", pr_state: "merged" });
  });

  it("a closed pr_ready item with the flag is archived too (without it, only a merge archives one)", async () => {
    const url = pr();
    const id = await ask(url, { type: "pr_ready" });
    await closed(url, false);
    expect((await item(id)).data).toMatchObject({ status: "archived", decision: { choice: "closed" } });
  });

  it("an open auto_decided item keeps the agent's own decision: the merge only sets pr_state", async () => {
    const url = pr();
    const id = await ask(url, { type: "auto_decided", decision: { choice: "pin", decided_at: "2026-10-07T00:00:00Z" } });
    await closed(url, true);
    expect((await item(id)).data).toMatchObject({ status: "open", pr_state: "merged", decision: { choice: "pin" } });
  });

  it("close_on_pr must be a boolean", async () => {
    const r = await human.put(`/api/items/${uid("cop-bad")}`, { data: { type: "decision", title: "t", close_on_pr: "yes" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/close_on_pr/);
  });
});

// close_on_pr closes a question, so it follows the same ownership rule as
// withdraw: an orchestrator token can drive a closure (set or clear the flag,
// or re-point the PR link on a flagged item) only on an item it posted with
// source = its id. Otherwise it could close a manager's question by flagging
// it, linking a PR it controls, and closing that PR.
describe("GitHub hook: close_on_pr only closes the asker's own questions", () => {
  const O = "O-cop";
  let orch: ReturnType<typeof agent>;
  const pr = () => `https://github.com/acme/repo/pull/${Math.floor(Math.random() * 1e6)}`;
  const closed = (url: string, merged: boolean) =>
    github("pull_request", { action: "closed", pull_request: { html_url: url, merged } });
  const item = async (id: string) => (await human.get(`/api/items/${id}`)).body;
  // A manager's question about O-cop's work: orchestrator O-cop, source sweep:O-cop.
  const managers = async (data: Record<string, unknown> = {}) => {
    const id = uid("cop-mgr");
    await createItem(id, { orchestrator: O, source: `sweep:${O}`, ...data });
    return id;
  };

  beforeAll(async () => {
    orch = agent((await mintToken("orchestrator", O, "cop-token")).secret);
  });

  it("can't flag a manager's item and link a PR it controls, so closing that PR leaves it open", async () => {
    const id = await managers();
    const url = pr();
    const r = await orch.patch(`/api/items/${id}`, { data: { close_on_pr: true, links: [{ label: "PR", url }] } });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/only on items they posted/);
    // Nor in two steps: links are a closure field too (CLOSURE_FIELDS), so neither step lands.
    expect((await orch.patch(`/api/items/${id}`, { data: { links: [{ label: "PR", url }] } })).status).toBe(403);
    expect((await orch.patch(`/api/items/${id}`, { data: { close_on_pr: true } })).status).toBe(403);
    await closed(url, false);
    const doc = await item(id);
    expect(doc.data).toMatchObject({ status: "open" });
    expect(doc.data.links).toBeUndefined();
    expect(doc.data.decision).toBeUndefined();
    expect(doc.data.pr_state).toBeUndefined(); // never linked to that PR
  });

  it.each([
    ["clear it (null)", { close_on_pr: null }],
    ["set it false", { close_on_pr: false }],
  ])("can't %s on a manager's flagged item either", async (_, data) => {
    const id = await managers({ close_on_pr: true, links: [{ label: "PR", url: pr() }] });
    expect((await orch.patch(`/api/items/${id}`, { data })).status).toBe(403);
    expect((await item(id)).data.close_on_pr).toBe(true);
  });

  it.each(["links", "evidence"])("can't re-point %s on a manager's flagged item at another PR", async (field) => {
    const mine = pr(), theirs = pr();
    const id = await managers({ close_on_pr: true, links: [{ label: "PR", url: theirs }] });
    const r = await orch.patch(`/api/items/${id}`, { data: { [field]: [{ label: "PR", url: mine }] } });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/only on items they posted/);
    await closed(mine, false);
    expect((await item(id)).data.status).toBe("open");
    // The manager's own link still closes it, as the manager meant.
    await closed(theirs, true);
    expect((await item(id)).data).toMatchObject({ status: "archived", decision: { ended: "merged" } });
  });

  it("a replace of a manager's flagged item must carry the flag and links verbatim; other edits pass", async () => {
    const id = await managers({ close_on_pr: true, links: [{ label: "PR", url: pr() }] });
    expect((await orch.patch(`/api/items/${id}`, { data: { summary: "context" } })).status).toBe(200);
    const { data } = await item(id);
    expect((await orch.put(`/api/items/${id}`, { data: { ...data, summary: "more" } })).status).toBe(200);
    expect((await orch.put(`/api/items/${id}`, { data: { ...data, links: [{ label: "PR", url: pr() }] } })).status).toBe(403);
    const { close_on_pr: _, ...unflagged } = data;
    expect((await orch.put(`/api/items/${id}`, { data: unflagged })).status).toBe(403);
  });

  it.each([
    ["another source", { source: "O-elsewhere" }],
    ["a manager source", { source: `sweep:${O}` }],
    ["no source", {}],
  ])("can't create a flagged item with %s", async (_, data) => {
    const r = await orch.put(`/api/items/${uid("cop-new")}`, {
      data: { type: "decision", title: "t", orchestrator: O, close_on_pr: true, links: [{ label: "PR", url: pr() }], ...data },
    });
    expect(r.status).toBe(403);
  });

  it("its own item: flagged at post time, link re-pointed later, closes when that PR merges", async () => {
    const first = pr(), second = pr();
    const id = uid("cop-own");
    const c = await orch.put(`/api/items/${id}`, {
      data: { type: "decision", title: "hold", orchestrator: O, source: O, close_on_pr: true, links: [{ label: "PR", url: first }] },
      if_version: 0,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await orch.patch(`/api/items/${id}`, { data: { links: [{ label: "PR", url: second }] } })).status).toBe(200);
    await closed(first, true);
    expect((await item(id)).data.status).toBe("open");
    await closed(second, true);
    expect((await item(id)).data).toMatchObject({
      status: "archived",
      decision: { choice: "merged", ended: "merged", by: "hook:github" },
    });
  });

  it("its own item: it may also set or clear the flag later", async () => {
    const id = uid("cop-own2");
    await orch.put(`/api/items/${id}`, { data: { type: "decision", title: "hold", orchestrator: O, source: O }, if_version: 0 });
    expect((await orch.patch(`/api/items/${id}`, { data: { close_on_pr: true } })).status).toBe(200);
    expect((await orch.patch(`/api/items/${id}`, { data: { close_on_pr: null } })).status).toBe(200);
  });
});

describe("ntfy decide hook", () => {
  const secret = () => env.NTFY_ACTION_SECRET!;
  const link = async (item: string, choice: string, exp: number, created: string, sig?: string, ver = 1) => {
    const s = sig ?? (await signDecide(secret(), item, choice, exp, created, ver));
    const q = new URLSearchParams({ item, choice, exp: String(exp), created, ver: String(ver), sig: s });
    const res = await exports.default.fetch(`https://inbox.test/hooks/ntfy/decide?${q}`, { method: "POST" });
    return { status: res.status, body: (await res.json()) as any };
  };
  const future = () => Math.floor(Date.now() / 1000) + 3600;

  it("a good signature decides the item as hook:ntfy", async () => {
    const id = uid("n");
    const doc = await createItem(id, { type: "proposal" });
    const r = await link(id, "approve", future(), doc.created_at);
    expect(r).toEqual({ status: 200, body: { ok: true, status: "decided" } });
    const item = (await human.get(`/api/items/${id}`)).body;
    expect(item.data.decision).toMatchObject({ choice: "approve", note: "via ntfy", by: "hook:ntfy" });
    expect(item.updated_by).toBe("hook:ntfy");
    expect((await link(id, "approve", future(), doc.created_at)).status).toBe(409);
  });

  it("a signed choice the item doesn't offer is 400 and leaves it open", async () => {
    const id = uid("n");
    const doc = await createItem(id, { type: "proposal", options: [{ id: "a", label: "A" }] });
    const r = await link(id, "approve", future(), doc.created_at);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_request");
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
    expect((await link(id, "a", future(), doc.created_at)).status).toBe(200);
  });

  it("a bad or expired signature is 401", async () => {
    const id = uid("n");
    const { created_at } = await createItem(id, { type: "proposal" });
    expect((await link(id, "approve", future(), created_at, "00".repeat(32))).status).toBe(401);
    const exp = future();
    const sig = await signDecide(secret(), id, "approve", exp, created_at, 1);
    expect((await link(id, "reject", exp, created_at, sig)).status).toBe(401); // signature is per choice
    expect((await link(id, "approve", exp, "2020-01-01T00:00:00.000Z", sig)).status).toBe(401); // and per item instance
    expect((await link(id, "approve", exp, created_at, sig, 2)).status).toBe(401); // and per version
    expect((await link(id, "approve", Math.floor(Date.now() / 1000) - 10, created_at)).status).toBe(401);
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
  });

  it("links without ver (signed before versions were) are refused", async () => {
    const id = uid("n");
    const { created_at } = await createItem(id, { type: "proposal" });
    const exp = future();
    const sig = await hmacHex(secret(), `${id}|approve|${exp}|${created_at}`);
    const q = new URLSearchParams({ item: id, choice: "approve", exp: String(exp), created: created_at, sig });
    const res = await exports.default.fetch(`https://inbox.test/hooks/ntfy/decide?${q}`, { method: "POST" });
    expect(res.status).toBe(401);
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
  });

  it("an item edited after the push is 409 conflict: the tap never approves text the human didn't see", async () => {
    const id = uid("n");
    const doc = await createItem(id, { type: "proposal", title: "Rename a variable" });
    await human.patch(`/api/items/${id}`, {
      data: { title: "Drop the prod database", options: [{ id: "approve", label: "Drop it" }] },
    });
    const r = await link(id, "approve", future(), doc.created_at, undefined, doc.version);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "conflict", current: { version: 2 } });
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
    expect((await link(id, "approve", future(), doc.created_at, undefined, 2)).status).toBe(200);
  });

  it("a link for a deleted-and-recreated item is 409 not_open", async () => {
    const id = uid("n");
    const old = await createItem(id, { type: "proposal" });
    await human.del(`/api/items/${id}`);
    await new Promise((r) => setTimeout(r, 5)); // a different created_at
    await createItem(id, { type: "proposal" });
    const r = await link(id, "approve", future(), old.created_at);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_open");
    expect((await human.get(`/api/items/${id}`)).body.data.status).toBe("open");
  });
});

describe("ntfy publish", () => {
  afterEach(() => vi.restoreAllMocks());

  const put = (id: string, data: unknown) =>
    new Request(`http://localhost/api/items/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });

  it("publishes created proposals with signed actions, never failing the request", async () => {
    const sent: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push({ url: String(input instanceof Request ? input.url : input), init, body: JSON.parse(String(init?.body)) });
      return new Response("boom", { status: 500 });
    });
    const ntfyEnv = { ...env, NTFY_TOPIC: "inbox-topic", NTFY_SERVER: "https://ntfy.test", NTFY_TOKEN: "tk" };
    const id = uid("pub");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      put(id, { type: "proposal", title: "Do X", question: "Approve X?", recommendation: { option: "reject" } }),
      ntfyEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);
    const created = ((await res.json()) as any).created_at;
    expect(sent).toHaveLength(1);
    const { url, init, body } = sent[0];
    expect(url).toBe("https://ntfy.test/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
    expect(body).toMatchObject({ topic: "inbox-topic", title: "Do X", message: "Approve X?" });
    expect(body.actions[0]).toEqual({ action: "view", label: "Open", url: `https://inbox.test/#item.${id}` });
    expect(body.actions.map((a: any) => a.label)).toEqual(["Open", "Reject", "Approve"]);
    const decideUrl = new URL(body.actions[1].url);
    expect(decideUrl.pathname).toBe("/hooks/ntfy/decide");
    expect(decideUrl.searchParams.get("created")).toBe(created);
    expect(decideUrl.searchParams.get("ver")).toBe("1");
    const exp = Number(decideUrl.searchParams.get("exp"));
    expect(decideUrl.searchParams.get("sig")).toBe(await signDecide(env.NTFY_ACTION_SECRET!, id, "reject", exp, created, 1));

    // info items don't notify; nor does a replace.
    const ctx2 = createExecutionContext();
    await worker.fetch(put(uid(), { title: "fyi" }), ntfyEnv, ctx2);
    await worker.fetch(put(id, { type: "proposal", title: "Do X" }), ntfyEnv, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(sent).toHaveLength(1);

    // Buttons come from the page's choices (shared/choices.ts), so every
    // link is a choice decide accepts; an ack-only ask gets none.
    const labels = async (data: Record<string, unknown>) => {
      sent.length = 0;
      const c = createExecutionContext();
      await worker.fetch(put(uid(), { title: "t", ...data }), ntfyEnv, c);
      await waitOnExecutionContext(c);
      return sent[0].body.actions.map((a: any) => a.label);
    };
    expect(await labels({ type: "proposal", options: [] })).toEqual(["Open", "Approve", "Reject"]);
    expect(await labels({ type: "decision", options: [{ id: "other", label: "Other" }, { id: "a", label: "A" }] })).toEqual([
      "Open",
      "A",
    ]);
    expect(await labels({ type: "blocker" })).toEqual(["Open"]);
  });
});
