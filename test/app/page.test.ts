import { describe, expect, it } from "vitest";
import { HeadingFocus, isNewPage, pageTitle } from "../../src/lib/page.ts";

describe("pageTitle", () => {
  it("is the app name on the inbox, with the open count in front", () => {
    expect(pageTitle({ view: "tab", tab: "inbox" }, { need: 0 })).toBe("Agent Inbox");
    expect(pageTitle({ view: "tab", tab: "inbox" }, { need: 3 })).toBe("(3) Agent Inbox");
  });

  it("names the Team and History tabs and Settings", () => {
    expect(pageTitle({ view: "tab", tab: "team" }, { need: 0 })).toBe("Team – Agent Inbox");
    expect(pageTitle({ view: "tab", tab: "history" }, { need: 2 })).toBe("(2) History – Agent Inbox");
    expect(pageTitle({ view: "settings" }, { need: 1 })).toBe("(1) Settings – Agent Inbox");
  });

  it("uses the item's title on an item page", () => {
    expect(pageTitle({ view: "item", id: "a" }, { need: 4, itemTitle: "Ship the change log" })).toBe("(4) Ship the change log – Agent Inbox");
  });

  it("falls back to the app name while the item isn't loaded", () => {
    expect(pageTitle({ view: "item", id: "a" }, { need: 0, itemTitle: null })).toBe("Agent Inbox");
  });

  it("names an untitled item", () => {
    expect(pageTitle({ view: "item", id: "a" }, { need: 0, itemTitle: "  " })).toBe("(untitled) – Agent Inbox");
  });

  it("uses the orchestrator's id and goal on its page", () => {
    expect(pageTitle({ view: "orch", id: "O3" }, { need: 0, orch: { id: "O3", goal: "Dedupe webhooks" } })).toBe("O3 · Dedupe webhooks – Agent Inbox");
    expect(pageTitle({ view: "orch", id: "O3" }, { need: 0, orch: { id: "O3" } })).toBe("O3 – Agent Inbox");
    expect(pageTitle({ view: "orch", id: "O9" }, { need: 0, orch: null })).toBe("O9 – Agent Inbox");
  });

  it("names the Reviews tab, and a run or PR page by its title once loaded", () => {
    expect(pageTitle({ view: "tab", tab: "reviews" }, { need: 1 })).toBe("(1) Reviews – Agent Inbox");
    expect(pageTitle({ view: "pr", routine: null, n: 812 }, { need: 0, review: "#812 Return 413" })).toBe("#812 Return 413 – Agent Inbox");
    expect(pageTitle({ view: "run", routine: null, stamp: "2026-10-08T181500Z" }, { need: 0, review: null })).toBe("Agent Inbox");
  });
});

describe("isNewPage", () => {
  it("is true on first load and on a change of view", () => {
    expect(isNewPage(null, { view: "item", id: "a" })).toBe(true);
    expect(isNewPage({ view: "tab", tab: "inbox" }, { view: "item", id: "a" })).toBe(true);
    expect(isNewPage({ view: "item", id: "a" }, { view: "orch", id: "a" })).toBe(true);
  });

  it("is true for another item or tab, false for the same one", () => {
    expect(isNewPage({ view: "item", id: "a" }, { view: "item", id: "b" })).toBe(true);
    expect(isNewPage({ view: "item", id: "a" }, { view: "item", id: "a" })).toBe(false);
    expect(isNewPage({ view: "tab", tab: "inbox" }, { view: "tab", tab: "team" })).toBe(true);
    expect(isNewPage({ view: "settings" }, { view: "settings" })).toBe(false);
  });

  it("tells runs apart by stamp and PRs by number and routine", () => {
    const run = (stamp: string) => ({ view: "run" as const, routine: null, stamp });
    expect(isNewPage(run("2026-10-08T181500Z"), run("2026-10-08T181500Z"))).toBe(false);
    expect(isNewPage(run("2026-10-08T181500Z"), run("2026-10-08T161000Z"))).toBe(true);
    expect(isNewPage({ view: "pr", routine: null, n: 812 }, { view: "pr", routine: null, n: 812 })).toBe(false);
    expect(isNewPage({ view: "pr", routine: null, n: 812 }, { view: "pr", routine: null, n: 809 })).toBe(true);
    expect(isNewPage({ view: "pr", routine: null, n: 812 }, { view: "pr", routine: "review-bot-dry", n: 812 })).toBe(true);
  });
});

describe("HeadingFocus", () => {
  it("focuses the heading once after a navigation", () => {
    const f = new HeadingFocus();
    f.arm();
    expect(f.take(true, true)).toBe(true);
    expect(f.take(true, true)).toBe(false); // the next live re-render leaves focus alone
  });

  it("never focuses on a render that no navigation armed", () => {
    expect(new HeadingFocus().take(true, true)).toBe(false);
  });

  it("waits through the loading skeleton for the first real render", () => {
    const f = new HeadingFocus();
    f.arm();
    expect(f.take(false, false)).toBe(false);
    expect(f.take(true, true)).toBe(true);
  });

  it("gives up when the loaded page has no heading", () => {
    const f = new HeadingFocus();
    f.arm();
    expect(f.take(true, false)).toBe(false); // e.g. "This item isn't in the inbox any more"
    expect(f.take(true, true)).toBe(false);  // a later live render doesn't steal focus
  });

  it("is dropped when the viewer leaves for a list", () => {
    const f = new HeadingFocus();
    f.arm();
    f.disarm();
    expect(f.take(true, true)).toBe(false);
  });
});
