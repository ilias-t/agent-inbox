import { describe, expect, it } from "vitest";
import type { ReviewEvent, ReviewPrRow } from "../../shared/types.ts";
import type { ItemRow } from "../../src/lib/items.ts";
import type { ReviewRun } from "../../shared/types.ts";
import { alsoPrsOf, asksFor, cardAction, filterTimeline, prFetchView, prTimeline, refillOlder, reviewPrOf, rvHead } from "../../src/lib/reviews.ts";
import { UI_REPO, UI_ROUTINE, stampOf, uiRoutine, uiRuns } from "../fixtures/review-ui.ts";

// Thu 8 Oct 2026, 15:30 in New York; the next run is at 16:15.
const NOW = Date.parse("2026-10-08T19:30:00Z"), TZ = "America/New_York", MIN = 60000;
const data = uiRoutine(NOW);
const row = (n: number): ReviewPrRow => data.prs.find((r) => r.number === n)!;
const iso = (ms: number) => new Date(ms).toISOString();

function ask(id: string, over: Partial<ItemRow> = {}): ItemRow {
  return {
    id, type: "decision", status: "open", title: "#812: fail with 413, or truncate?", orchestrator: UI_ROUTINE, source: UI_ROUTINE,
    options: [{ id: "fail", label: "Fail with 413" }, { id: "truncate", label: "Truncate and warn" }], created_at: iso(NOW - 70 * MIN), ...over,
  };
}
const decided = (id: string) => ask(id, { status: "decided", decision: { choice: "fail", note: "", decided_at: iso(NOW - 10 * MIN), by: "human:you@example.com" } });

describe("reviewPrOf", () => {
  it("reads the PR an ask is about from review_pr, as the runner sets it", () => {
    expect(reviewPrOf(ask("x", { review_pr: { routine: UI_ROUTINE, number: 812 } }), [UI_ROUTINE])).toEqual({ routine: UI_ROUTINE, n: 812 });
  });
  it("falls back to the runner's item id, <routine>-<pr>-<hold>[-k]", () => {
    expect(reviewPrOf(ask("review-bot-812-product"), [UI_ROUTINE])).toEqual({ routine: UI_ROUTINE, n: 812 });
    expect(reviewPrOf(ask("review-bot-812-product-2"), [UI_ROUTINE])).toEqual({ routine: UI_ROUTINE, n: 812 });
  });
  it("ignores another orchestrator's item, whatever its review_pr or id says", () => {
    expect(reviewPrOf(ask("x", { orchestrator: "O3", review_pr: { routine: UI_ROUTINE, number: 812 } }), [UI_ROUTINE])).toBeNull();
    expect(reviewPrOf(ask("review-bot-812-product", { orchestrator: "O3" }), [UI_ROUTINE])).toBeNull();
    expect(reviewPrOf(ask("review-bot-812-product", { orchestrator: undefined }), [UI_ROUTINE])).toBeNull();
    expect(asksFor([ask("review-bot-812-product", { orchestrator: "O3" })], UI_ROUTINE, 812)).toEqual([]);
  });
  it("ignores items of routines that haven't reported, and other ids", () => {
    expect(reviewPrOf(ask("review-bot-812-product"), ["other"])).toBeNull();
    expect(reviewPrOf(ask("O3-changelog", { orchestrator: "O3" }), [UI_ROUTINE])).toBeNull();
    expect(reviewPrOf(ask("x", { review_pr: { routine: UI_ROUTINE, number: -1 } }), [UI_ROUTINE])).toBeNull();
  });
});

describe("asksFor", () => {
  it("finds the routine's items about one PR, newest first", () => {
    const old = ask("review-bot-812-product", { created_at: iso(NOW - 2 * 86400000), status: "archived" });
    const cur = ask("review-bot-812-product-2"), other = ask("review-bot-809-product");
    expect(asksFor([old, other, cur], UI_ROUTINE, 812).map((i) => i.id)).toEqual(["review-bot-812-product-2", "review-bot-812-product"]);
  });
});

describe("a shared call (review_pr.also)", () => {
  const shared = ask("review-bot-4736-product", { review_pr: { routine: UI_ROUTINE, number: 4736, also: [4737, 4738] } });
  it("is an ask on its own PR and on each PR in also", () => {
    expect(asksFor([shared], UI_ROUTINE, 4736).map((i) => i.id)).toEqual(["review-bot-4736-product"]);
    expect(asksFor([shared], UI_ROUTINE, 4737).map((i) => i.id)).toEqual(["review-bot-4736-product"]);
    expect(asksFor([shared], UI_ROUTINE, 4739)).toEqual([]);
    expect(reviewPrOf(shared, [UI_ROUTINE])).toEqual({ routine: UI_ROUTINE, n: 4736 });
  });
  it("lists the other PRs, keeping only PR numbers", () => {
    expect(alsoPrsOf(shared)).toEqual([4737, 4738]);
    expect(alsoPrsOf(ask("x", { review_pr: { routine: UI_ROUTINE, number: 1, also: [2, "3", -4, 2] } }))).toEqual([2]);
    expect(alsoPrsOf(ask("x"))).toEqual([]);
  });
});

describe("rvHead", () => {
  it("sends an open ask to the Inbox to decide", () => {
    expect(rvHead(row(812), [ask("review-bot-812-product")], data.routine.next_run_at, TZ, NOW)).toEqual({
      chip: "you", label: "Needs you · Held · product call", clears: "Clears when you decide in the Inbox or review on GitHub.",
      action: { text: "Decide in Inbox", href: "#item.review-bot-812-product", external: false },
    });
  });
  it("says a decided ask relays at the next run, with what was chosen", () => {
    expect(rvHead(row(812), [decided("review-bot-812-product")], data.routine.next_run_at, TZ, NOW)).toEqual({
      chip: "decided", label: "Decided · relays at 16:15", clears: "You chose “Fail with 413”. The next run posts it on GitHub.",
      action: { text: "Review on GitHub ↗", href: `${UI_REPO}/pull/812`, external: true },
    });
  });
  it("says next run when the routine has no next run time", () => {
    expect(rvHead(row(812), [decided("review-bot-812-product")], null, TZ, NOW).label).toBe("Decided · relays next run");
  });
  it("goes by the PR's status with no ask, or only a closed one", () => {
    const closed = ask("review-bot-806-owner", { status: "archived" });
    expect(rvHead(row(806), [closed], null, TZ, NOW)).toEqual({
      chip: "held", label: "Held · owner's area", clears: "Clears when the code owner approves or asks for your approval.",
      action: { text: "Review on GitHub ↗", href: `${UI_REPO}/pull/806`, external: true },
    });
  });
});

describe("prTimeline", () => {
  const ev = (stamp: string, at: number, action: ReviewEvent["data"]["action"], changes: string[] = []): ReviewEvent => ({
    routine: UI_ROUTINE, number: 812, stamp,
    data: { pr: 812, stamp, at: iso(at), title: "t", url: `${UI_REPO}/pull/812`, role: "reviewing", action, review_url: action === "none" ? null : `${UI_REPO}/pull/812#pullrequestreview-1`,
      summary: action === "none" ? null : "Size check reads the header", changes, status: "held_product", status_note: null, log: null },
  });
  const events = [ev("2026-10-08T181500Z", NOW - 75 * MIN, "commented", ["Author pushed 2 commits"]), ev("2026-10-07T161000Z", NOW - 1640 * MIN, "approved")];
  const withGh: ReviewPrRow = { ...row(812), gh: { reviews: [{ login: "mara-k", state: "commented", at: iso(NOW - 30 * MIN) }, { login: "devon", state: "approved", at: iso(NOW - 20 * MIN) }] } };
  const t = prTimeline(withGh, events, [decided("review-bot-812-product")], "you@example.com");

  it("merges the routine's runs, the author's changes, others' reviews and your decisions, newest first", () => {
    expect(t.map((e) => [e.who, e.verb])).toEqual([
      ["you", "You chose"], ["other", "devon approved"], ["author", "mara-k commented"], ["routine", "Asked you"],
      ["routine", "Commented"], ["author", "Changed"], ["routine", "Approved"],
    ]);
  });
  it("links each entry to its review, or to the ask in the Inbox", () => {
    expect(t[0]).toMatchObject({ text: "Fail with 413", href: "#item.review-bot-812-product", url: null });
    expect(t.find((e) => e.verb === "Commented")).toMatchObject({ text: "Size check reads the header", url: `${UI_REPO}/pull/812#pullrequestreview-1` });
    expect(t.find((e) => e.verb === "Changed")).toMatchObject({ text: "Author pushed 2 commits" });
  });
  it("filters to the routine, the author or you", () => {
    expect(filterTimeline(t, "author").map((e) => e.verb)).toEqual(["mara-k commented", "Changed"]);
    expect(filterTimeline(t, "you").map((e) => e.verb)).toEqual(["You chose"]);
    expect(filterTimeline(t, "routine").map((e) => e.verb)).toEqual(["Asked you", "Commented", "Approved"]);
    expect(filterTimeline(t, "all")).toHaveLength(t.length);
  });
  it("counts only your own decision as yours; a token's, someone else's or a withdrawal isn't", () => {
    expect(prTimeline(row(812), [], [decided("review-bot-812-product")], "someone@example.com").map((e) => [e.who, e.verb])).toEqual([
      ["other", "Decided"], ["routine", "Asked you"],
    ]);
    const byToken = ask("review-bot-812-product", { status: "decided", decision: { choice: "fail", decided_at: iso(NOW), by: "token:manager" } });
    const withdrawn = ask("review-bot-812-product-2", { status: "archived", decision: { choice: "withdrawn", ended: "withdrawn", note: "Hold cleared on GitHub", decided_at: iso(NOW), by: "token:orch-review-bot" } });
    expect(prTimeline(row(812), [], [byToken, withdrawn], "you@example.com").map((e) => [e.who, e.verb])).toEqual([
      ["other", "Decided"], ["routine", "Withdrew the ask"], ["routine", "Asked you"], ["routine", "Asked you"],
    ]);
  });
});

describe("refillOlder", () => {
  // 61 runs an hour apart, newest first; pages of `size` before a stamp, as GET /api/reviews/:routine?before= serves them.
  const all: ReviewRun[] = Array.from({ length: 61 }, (_, i) => ({ ...uiRuns(NOW)[0], stamp: stampOf(NOW - i * 3600000) }));
  const page = (runs: ReviewRun[], size: number) => async (before: string) => {
    const older = runs.filter((r) => r.stamp < before);
    return { runs: older.slice(0, size), more: older.length > size };
  };
  const stamps = (rs: ReviewRun[]) => rs.map((r) => r.stamp);

  it("refetches what a live refresh pushed out of the newest page, so the window stays continuous", async () => {
    // Loaded: runs 1-30 (the newest page) and 31-60 (Load older). Then run 0 lands: the newest page is 0-29.
    const older = { runs: all.slice(31, 61), more: false };
    const got = await refillOlder(all.slice(0, 30), older, page(all, 100));
    expect(stamps([...all.slice(0, 30), ...got.runs])).toEqual(stamps(all));
    expect(got.more).toBe(false);
  });
  it("pages until it reaches the oldest run loaded, and keeps whether there are more below it", async () => {
    const older = { runs: all.slice(31, 50), more: true };
    const got = await refillOlder(all.slice(0, 30), older, page(all, 7));
    expect(stamps(got.runs)).toEqual(stamps(all.slice(30, 50)));
    expect(got.more).toBe(true);
  });
  it("leaves nothing to refill when no older page was loaded", async () => {
    const older = { runs: [], more: null };
    expect(await refillOlder(all.slice(0, 30), older, () => { throw new Error("no fetch"); })).toBe(older);
  });
});

describe("cardAction", () => {
  const needs = (...ns: number[]) => ns.map(row);
  it("decides the one PR that needs you in the Inbox when it has an open ask", () => {
    expect(cardAction(needs(812), [ask("review-bot-812-product")], UI_ROUTINE)).toEqual({ kind: "button", text: "Decide in Inbox", href: "#item.review-bot-812-product" });
  });
  it("opens the one PR that needs you when it has no ask", () => {
    expect(cardAction(needs(798), [], UI_ROUTINE)).toEqual({ kind: "button", text: "Open #798", href: "#pr.review-bot.798" });
  });
  it("points at the Needs you group when more than one PR needs you, and at nothing when none does", () => {
    expect(cardAction(needs(812, 798), [ask("review-bot-812-product")], UI_ROUTINE)).toEqual({ kind: "group" });
    expect(cardAction([], [], UI_ROUTINE)).toBeNull();
  });
});

describe("prFetchView", () => {
  const got = { pr: row(812), events: [] };
  it("fetches a PR it has nothing for, or whose routine moved on, showing what it had meanwhile", () => {
    expect(prFetchView(undefined, 3)).toEqual({ show: "loading", fetch: true });
    expect(prFetchView({ version: 2, state: "ok", data: got }, 3)).toEqual({ show: got, fetch: true });
    expect(prFetchView({ version: 2, state: "failed", data: null }, 3)).toEqual({ show: "loading", fetch: true });
  });
  it("keeps showing what it had on every render while that fetch is in flight, not only the first", () => {
    expect(prFetchView({ version: 3, state: "loading", data: got }, 3)).toEqual({ show: got, fetch: false });
    expect(prFetchView({ version: 2, state: "loading", data: got }, 3)).toEqual({ show: got, fetch: false });
    expect(prFetchView({ version: 3, state: "loading", data: null }, 3)).toEqual({ show: "loading", fetch: false });
  });
  it("shows a current answer as it is", () => {
    expect(prFetchView({ version: 3, state: "ok", data: got }, 3)).toEqual({ show: got, fetch: false });
    expect(prFetchView({ version: 3, state: "ok", data: null }, 3)).toEqual({ show: "failed", fetch: false });
    expect(prFetchView({ version: 3, state: "missing", data: null }, 3)).toEqual({ show: "missing", fetch: false });
    expect(prFetchView({ version: 3, state: "failed", data: null }, 3)).toEqual({ show: "failed", fetch: false });
  });
});
