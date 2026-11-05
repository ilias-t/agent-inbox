// POST /hooks/github onto review_prs (docs/reviews.md "GitHub hook"): each delivery merges its facts into the
// `gh` column of every routine's row for the PR url, never `data`, and bumps each changed routine's head in the
// same batch, so each routine gets exactly one change row. Merged is terminal; closed revives only on a reopen.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { writeReviewPrs } from "../../worker/hooks/github.ts";
import { hmacHex } from "../../worker/http.ts";
import { createItem, human, uid } from "./helpers.ts";
import { changesFor, maxSeq, reportOf, routine, stamp } from "./reviews-helpers.ts";

// `delivery`: GitHub's X-GitHub-Delivery id, which a redelivery repeats.
async function github(event: string, payload: unknown, secret = env.GITHUB_WEBHOOK_SECRET!, delivery = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  const res = await exports.default.fetch("https://inbox.test/hooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": `sha256=${await hmacHex(secret, body)}`,
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as any };
}

// A PR url no other test uses (the hook matches on url across routines).
const prUrl = (n = 4700) => `https://github.com/acme/${uid("repo")}/pull/${n}`;

// A routine whose newest report tracks PR `n` at `url`.
async function tracking(url: string, n = 4700) {
  const r = await routine();
  const res = await r.report({ stamp: stamp(0), report: reportOf([n], {}, () => ({ url })) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return r;
}

const prRow = async (routineId: string, n = 4700) =>
  (await env.DB.prepare("SELECT data, gh, gone_at, updated_at FROM review_prs WHERE routine = ? AND number = ?").bind(routineId, n).first<{
    data: string;
    gh: string | null;
    gone_at: string | null;
    updated_at: string;
  }>())!;
const gh = async (routineId: string, n = 4700) => {
  const g = (await prRow(routineId, n)).gh;
  return g ? JSON.parse(g) : null;
};

// Runs `deliver` and returns its response with the change rows it added for each routine.
async function logged(ids: string[], deliver: () => Promise<{ status: number; body: any }>) {
  const before = await Promise.all(ids.map(async (id) => (await changesFor(id)).length));
  const res = await deliver();
  const added = await Promise.all(ids.map(async (id, i) => (await changesFor(id)).slice(before[i])));
  return { res, added };
}

const pullRequest = (action: string, url: string, pr: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  github("pull_request", { action, pull_request: { html_url: url, ...pr }, ...extra });
const review = (url: string, login: string, state: string, at: string) =>
  github("pull_request_review", { action: "submitted", review: { state, user: { login }, submitted_at: at }, pull_request: { html_url: url } });

describe("GitHub hook: review_prs", () => {
  it("synchronize records the new head sha and when it was pushed, logged as one change row by hook:github", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const data = (await prRow(r.id)).data;
    const { res, added } = await logged([r.id], () =>
      pullRequest("synchronize", url, { head: { sha: "abc123" }, updated_at: "2026-10-08T15:30:00Z" }, { after: "abc123" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([{ collection: "reviews", id: r.id }]);
    expect(await gh(r.id)).toMatchObject({ head_sha: "abc123", pushed_at: "2026-10-08T15:30:00.000Z" });
    expect((await prRow(r.id)).data).toBe(data); // only a run writes data
    expect(added).toEqual([[
      { seq: expect.any(Number), collection: "reviews", doc_id: r.id, op: "update", version: 2, actor: "hook:github", orchestrator: r.id },
    ]]);
    // The tab reads it from the routine's PR list.
    const listed = (await human.get(`/api/reviews/${r.id}`)).body.prs.find((p: { number: number }) => p.number === 4700);
    expect(listed.gh).toMatchObject({ head_sha: "abc123", pushed_at: "2026-10-08T15:30:00.000Z" });
  });

  it("an older push delivered late doesn't move the head sha back, and logs nothing", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await pullRequest("synchronize", url, { head: { sha: "new" }, updated_at: "2026-10-08T16:00:00Z" });
    const { res, added } = await logged([r.id], () => pullRequest("synchronize", url, { head: { sha: "old" }, updated_at: "2026-10-08T15:00:00Z" }));
    expect(res.body.updated).toEqual([]);
    expect(added).toEqual([[]]);
    expect(await gh(r.id)).toMatchObject({ head_sha: "new", pushed_at: "2026-10-08T16:00:00.000Z" });
  });

  it("converted_to_draft and ready_for_review set gh.state", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await pullRequest("converted_to_draft", url, { draft: true });
    expect((await gh(r.id)).state).toBe("draft");
    await pullRequest("ready_for_review", url, { draft: false });
    expect((await gh(r.id)).state).toBe("open");
  });

  it("a submitted review records {login, state, at}; a redelivery records nothing", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await review(url, "sam", "APPROVED", "2026-10-08T14:32:00Z");
    await review(url, "kim", "CHANGES_REQUESTED", "2026-10-08T14:40:00Z");
    expect(await gh(r.id)).toEqual({
      reviews: [
        { login: "sam", state: "approved", at: "2026-10-08T14:32:00.000Z" },
        { login: "kim", state: "changes_requested", at: "2026-10-08T14:40:00.000Z" },
      ],
    });
    const { res, added } = await logged([r.id], () => review(url, "sam", "APPROVED", "2026-10-08T14:32:00Z"));
    expect(res.body.updated).toEqual([]);
    expect(added).toEqual([[]]);
    expect((await gh(r.id)).reviews).toHaveLength(2);
    // A pending (unsubmitted) review state isn't one we record.
    await review(url, "lee", "PENDING", "2026-10-08T14:50:00Z");
    expect((await gh(r.id)).reviews).toHaveLength(2);
  });

  it("keeps the newest 30 reviews", async () => {
    const url = prUrl();
    const r = await tracking(url);
    for (let i = 0; i < 32; i++) await review(url, `r${i}`, "commented", new Date(Date.UTC(2026, 9, 8, 14, i)).toISOString());
    const reviews = (await gh(r.id)).reviews;
    expect(reviews).toHaveLength(30);
    expect(reviews[0].login).toBe("r2");
    expect(reviews[29].login).toBe("r31");
  });

  it("merged sets gh.state and gone_at, and is terminal: a reopen, draft, push or review after it changes nothing", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await pullRequest("closed", url, { merged: true });
    const merged = await prRow(r.id);
    expect(JSON.parse(merged.gh!).state).toBe("merged");
    expect(merged.gone_at).toEqual(expect.any(String));
    const { added } = await logged([r.id], async () => {
      await pullRequest("reopened", url);
      await pullRequest("converted_to_draft", url, { draft: true });
      await pullRequest("synchronize", url, { head: { sha: "x" }, updated_at: "2026-10-09T00:00:00Z" });
      await review(url, "sam", "APPROVED", "2026-10-09T00:00:00Z");
      return pullRequest("closed", url, { merged: false });
    });
    expect(added).toEqual([[]]);
    expect(await prRow(r.id)).toEqual(merged);
  });

  it("closed sets gh.state and gone_at; a reopen revives it, and a merge after a close goes through", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await pullRequest("closed", url, { merged: false });
    const closed = await prRow(r.id);
    expect(JSON.parse(closed.gh!).state).toBe("closed");
    expect(closed.gone_at).toEqual(expect.any(String));
    // Closed ignores reviews, like items' pr_state (a draft or ready no newer than the close: see the races below).
    await review(url, "sam", "APPROVED", "2026-10-09T00:00:00Z");
    expect(await prRow(r.id)).toEqual(closed);

    const { res, added } = await logged([r.id], () => pullRequest("reopened", url, { draft: false }));
    expect(res.body.updated).toEqual([{ collection: "reviews", id: r.id }]);
    expect(added).toHaveLength(1);
    expect(await prRow(r.id)).toMatchObject({ gone_at: null });
    expect((await gh(r.id)).state).toBe("open");

    await pullRequest("closed", url, { merged: true });
    expect((await gh(r.id)).state).toBe("merged");
  });

  it("a draft PR reopens as a draft, and a closed one can merge without a reopen in between", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await pullRequest("closed", url, { merged: false });
    await pullRequest("reopened", url, { draft: true });
    expect((await gh(r.id)).state).toBe("draft");
    await pullRequest("closed", url, { merged: false });
    await pullRequest("closed", url, { merged: true });
    expect((await gh(r.id)).state).toBe("merged");
  });

  it("an unknown PR writes nothing", async () => {
    const url = prUrl();
    const seq = await maxSeq();
    for (const res of [
      await pullRequest("synchronize", url, { head: { sha: "abc" } }),
      await pullRequest("reopened", url),
      await review(url, "sam", "APPROVED", "2026-10-08T14:32:00Z"),
      await pullRequest("closed", url, { merged: true }),
    ]) {
      expect(res.status).toBe(200);
      expect(res.body.updated).toEqual([]);
    }
    expect(await maxSeq()).toBe(seq);
  });

  it("a bad signature is refused and writes nothing", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const res = await github("pull_request", { action: "synchronize", pull_request: { html_url: url, head: { sha: "x" } } }, "wrong");
    expect(res.status).toBe(401);
    expect(await gh(r.id)).toBeNull();
  });

  it("one url tracked by two routines updates both, bumping each head with exactly one change row", async () => {
    const url = prUrl();
    const a = await tracking(url);
    const b = await tracking(url);
    const other = await tracking(prUrl());
    const { res, added } = await logged([a.id, b.id, other.id], () => review(url, "sam", "APPROVED", "2026-10-08T14:32:00Z"));
    expect(res.body.updated).toEqual(
      expect.arrayContaining([
        { collection: "reviews", id: a.id },
        { collection: "reviews", id: b.id },
      ]),
    );
    expect(res.body.updated).toHaveLength(2);
    expect(added.map((rows) => rows.length)).toEqual([1, 1, 0]);
    expect(added[0][0]).toMatchObject({ op: "update", version: 2, actor: "hook:github", orchestrator: a.id });
    expect(added[1][0]).toMatchObject({ op: "update", version: 2, actor: "hook:github", orchestrator: b.id });
    for (const id of [a.id, b.id]) expect((await gh(id)).reviews).toEqual([{ login: "sam", state: "approved", at: "2026-10-08T14:32:00.000Z" }]);
  });

  it("a merge still archives a close_on_pr item and marks the routine's PR in the same delivery", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const item = uid("cop");
    await createItem(item, { close_on_pr: true, links: [{ label: "PR", url }] });
    const res = await pullRequest("closed", url, { merged: true });
    expect(res.body.updated).toEqual(
      expect.arrayContaining([
        { collection: "items", id: item },
        { collection: "reviews", id: r.id },
      ]),
    );
    expect(res.body.updated).toHaveLength(2);
    expect((await human.get(`/api/items/${item}`)).body.data).toMatchObject({ status: "archived", pr_state: "merged" });
    expect((await gh(r.id)).state).toBe("merged");
  });

  it("the new pull_request actions leave items' pr_state alone", async () => {
    const url = prUrl();
    const item = uid("pr");
    await createItem(item, { type: "pr_ready", links: [{ label: "PR", url }] });
    for (const action of ["synchronize", "reopened", "converted_to_draft", "ready_for_review"]) await pullRequest(action, url, { head: { sha: "x" } });
    expect((await human.get(`/api/items/${item}`)).body).toMatchObject({ version: 1, data: { status: "open" } });
    expect((await human.get(`/api/items/${item}`)).body.data.pr_state).toBeUndefined();
  });
});

// codex on #70: delivery order and identity, the url pin, one change row per routine across retries, and pushes
// within the same second.
describe("GitHub hook: review_prs under redelivery and races", () => {
  // A state delivery with its PR's updated_at, as GitHub sends it, under a fixed delivery id.
  const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 15, 0, s)).toISOString().replace(".000", "");
  const state = (action: string, url: string, t: string, delivery: string, pr: Record<string, unknown> = {}) =>
    github("pull_request", { action, pull_request: { html_url: url, updated_at: t, ...pr } }, undefined, delivery);

  it("a redelivered reopen after a later close leaves the PR closed and gone", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("closed", url, at(1), "d1", { merged: false });
    await state("reopened", url, at(2), "d2");
    await state("closed", url, at(3), "d3", { merged: false });
    const closed = await prRow(r.id);
    const { added } = await logged([r.id], () => state("reopened", url, at(2), "d2"));
    expect(added).toEqual([[]]);
    expect(await prRow(r.id)).toEqual(closed);
    expect((await gh(r.id)).state).toBe("closed");
    expect(closed.gone_at).toEqual(expect.any(String));
  });

  it("an earlier close replayed after the reopen leaves the PR open", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("closed", url, at(1), "d1", { merged: false });
    await state("reopened", url, at(2), "d2");
    const { res, added } = await logged([r.id], () => state("closed", url, at(1), "d1", { merged: false }));
    expect(res.body.updated).toEqual([]);
    expect(added).toEqual([[]]);
    expect(await prRow(r.id)).toMatchObject({ gone_at: null });
    expect((await gh(r.id)).state).toBe("open");
  });

  it("within one second, a redelivered close is still known by its delivery id", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("closed", url, at(1), "d1", { merged: false });
    await state("reopened", url, at(1), "d2");
    await state("closed", url, at(1), "d1", { merged: false });
    expect(await prRow(r.id)).toMatchObject({ gone_at: null });
    expect((await gh(r.id)).state).toBe("open");
    // A new close in that same second still goes through.
    await state("closed", url, at(1), "d3", { merged: false });
    expect((await gh(r.id)).state).toBe("closed");
  });

  it("an older draft or ready delivery doesn't override a newer one, and a merge always lands", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("ready_for_review", url, at(5), "d1");
    await state("converted_to_draft", url, at(4), "d2", { draft: true });
    expect((await gh(r.id)).state).toBe("open");
    await state("closed", url, at(3), "d3", { merged: true }); // older, but merged is final
    expect((await gh(r.id)).state).toBe("merged");
  });

  it("a second push in the same second with another sha is recorded; the same sha is a redelivery", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const push = (sha: string) => pullRequest("synchronize", url, { head: { sha }, updated_at: "2026-10-08T15:30:00Z" });
    await push("aaa");
    const second = await logged([r.id], () => push("bbb"));
    expect(second.added[0]).toHaveLength(1);
    expect(await gh(r.id)).toMatchObject({ head_sha: "bbb", pushed_at: "2026-10-08T15:30:00.000Z" });
    const again = await logged([r.id], () => push("bbb"));
    expect(again.added).toEqual([[]]);
  });

  it("a newer close that changes nothing visible still moves the watermark: a delayed older reopen stays out", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("closed", url, at(1), "d1", { merged: false });
    const t3 = await logged([r.id], () => state("closed", url, at(3), "d3", { merged: false }));
    expect(t3.added[0].length).toBeLessThanOrEqual(1);
    expect(await gh(r.id)).toMatchObject({ state: "closed", state_at: at(3).replace("Z", ".000Z") });
    const late = await logged([r.id], () => state("reopened", url, at(2), "d2"));
    expect(late.added).toEqual([[]]);
    expect((await gh(r.id)).state).toBe("closed");
    expect((await prRow(r.id)).gone_at).toEqual(expect.any(String));
  });

  it("close, reopen, draft delivered as close, draft, reopen: the newest (draft) wins and the PR is back", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("closed", url, at(1), "d1", { merged: false });
    // Newer than the close, so a reopen happened in between even though it hasn't arrived yet.
    await state("converted_to_draft", url, at(3), "d3", { draft: true });
    expect(await gh(r.id)).toMatchObject({ state: "draft", state_at: at(3).replace("Z", ".000Z") });
    expect((await prRow(r.id)).gone_at).toBeNull();
    const late = await logged([r.id], () => state("reopened", url, at(2), "d2"));
    expect(late.added).toEqual([[]]);
    expect((await gh(r.id)).state).toBe("draft");
  });

  it("a draft or ready delivery no newer than the close leaves the PR closed", async () => {
    const url = prUrl();
    const r = await tracking(url);
    await state("closed", url, at(2), "d1", { merged: false });
    await state("ready_for_review", url, at(1), "d2");
    await state("converted_to_draft", url, at(2), "d3", { draft: true });
    expect((await gh(r.id)).state).toBe("closed");
    expect((await prRow(r.id)).gone_at).toEqual(expect.any(String));
  });

  it("pushes A, A again under a new id, then B in one second; the second A replayed: B stays the head", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const push = (sha: string, delivery: string) =>
      github("pull_request", { action: "synchronize", pull_request: { html_url: url, head: { sha }, updated_at: "2026-10-08T15:30:00Z" } }, undefined, delivery);
    await push("aaa", "pa");
    const noop = await logged([r.id], () => push("aaa", "pa2"));
    expect(noop.added).toEqual([[]]);
    await push("bbb", "pb");
    const again = await logged([r.id], () => push("aaa", "pa2"));
    expect(again.res.body.updated).toEqual([]);
    expect(again.added).toEqual([[]]);
    expect((await gh(r.id)).head_sha).toBe("bbb");
    // A newer second starts over: aaa pushed again later is the head.
    await github("pull_request", { action: "synchronize", pull_request: { html_url: url, head: { sha: "aaa" }, updated_at: "2026-10-08T15:30:01Z" } }, undefined, "pa3");
    expect((await gh(r.id)).head_sha).toBe("aaa");
  });

  it("more than 20 pushes in one second: the first, replayed, still doesn't retake the head", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const push = (sha: string, delivery: string) =>
      github("pull_request", { action: "synchronize", pull_request: { html_url: url, head: { sha }, updated_at: "2026-10-08T15:30:00Z" } }, undefined, delivery);
    for (let i = 0; i < 22; i++) await push("sha" + i, "p" + i);
    const again = await logged([r.id], () => push("sha0", "p0"));
    expect(again.added).toEqual([[]]);
    expect((await gh(r.id)).head_sha).toBe("sha21");
  });

  it("pushes A then B in one second, then A redelivered: B stays the head and the redelivery logs nothing", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const push = (sha: string, delivery: string) =>
      github("pull_request", { action: "synchronize", pull_request: { html_url: url, head: { sha }, updated_at: "2026-10-08T15:30:00Z" } }, undefined, delivery);
    await push("aaa", "pa");
    await push("bbb", "pb");
    const again = await logged([r.id], () => push("aaa", "pa"));
    expect(again.res.body.updated).toEqual([]);
    expect(again.added).toEqual([[]]);
    expect((await gh(r.id)).head_sha).toBe("bbb");
  });

  it("a row whose url a report changed between the read and the write is left alone", async () => {
    const url = prUrl();
    const r = await tracking(url);
    const other = prUrl(4701);
    const before = await changesFor(r.id);
    const changed = await writeReviewPrs(env.DB, url, { kind: "end", state: "merged", at: at(1), delivery: "d1" }, new Date().toISOString(), async () => {
      await env.DB.prepare("UPDATE review_prs SET url = ? WHERE routine = ? AND number = 4700").bind(other, r.id).run();
    });
    expect(changed).toEqual([]);
    expect(await prRow(r.id)).toMatchObject({ gh: null, gone_at: null });
    expect(await changesFor(r.id)).toEqual(before);
  });

  it("a partial conflict on one routine's rows still logs exactly one change row", async () => {
    // Two PR entries of one report share the url.
    const url = prUrl();
    const r = await routine();
    expect((await r.report({ stamp: stamp(0), report: reportOf([4700, 4701], {}, () => ({ url })) })).status).toBe(201);
    const before = (await changesFor(r.id)).length;
    const changed = await writeReviewPrs(
      env.DB,
      url,
      { kind: "review", review: { login: "sam", state: "approved", at: "2026-10-08T14:32:00.000Z" } },
      new Date().toISOString(),
      async () => {
        // A report rewrites one of the two rows after the hook read them.
        await env.DB.prepare("UPDATE review_prs SET gone_at = '2026-10-08T15:00:00.000Z' WHERE routine = ? AND number = 4701").bind(r.id).run();
      },
    );
    expect(changed).toEqual([r.id]);
    expect((await changesFor(r.id)).length - before).toBe(1);
    for (const n of [4700, 4701]) expect((await gh(r.id, n)).reviews).toEqual([{ login: "sam", state: "approved", at: "2026-10-08T14:32:00.000Z" }]);
  });
});
