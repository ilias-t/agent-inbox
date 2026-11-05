import { describe, expect, it } from "vitest";
import { arrival, backLabel, backTarget, listOf, savedNav, upIsBack } from "../../src/lib/backnav.ts";
import type { Route } from "../../src/state.ts";

const item = (id: string): Route => ({ view: "item", id });
const orch = (id: string): Route => ({ view: "orch", id });
const pr: Route = { view: "pr", routine: "review-bot", n: 812 };
const run: Route = { view: "run", routine: "review-bot", stamp: "2026-10-08T181500Z" };
const tab = (t: "inbox" | "team" | "reviews" | "history"): Route => ({ view: "tab", tab: t });
const settings: Route = { view: "settings" };

describe("backTarget: where a page's back link, u and Esc go up to", () => {
  it("an item goes up to the list it was opened from, or to the orchestrator page it was opened from", () => {
    expect(backTarget(item("a"), tab("inbox"), "inbox", null, false)).toBe("#inbox");
    expect(backTarget(item("a"), tab("history"), "history", null, false)).toBe("#history");
    expect(backTarget(item("a"), orch("O3"), "team", null, false)).toBe("#orch.O3");
  });
  it("an item reached from a PR's Decide in Inbox goes up to the Inbox, not to Reviews' PR list it isn't in", () => {
    expect(backTarget(item("a"), pr, "reviews", null, false)).toBe("#inbox");
    expect(backTarget(item("a"), pr, "inbox", null, false)).toBe("#inbox");
  });
  it("paging keeps the way back; a row opened beside the item starts over", () => {
    expect(backTarget(item("b"), item("a"), "inbox", "#orch.O3", false)).toBe("#orch.O3");
    expect(backTarget(item("b"), item("a"), "inbox", "#orch.O3", true)).toBe("#inbox");
  });
  it("an orchestrator goes up to the list it was opened from, a run or a PR to Reviews wherever they were opened from", () => {
    expect(backTarget(orch("O3"), item("a"), "inbox", null, false)).toBe("#inbox");
    expect(backTarget(orch("O3"), tab("team"), "team", null, false)).toBe("#team");
    expect(backTarget(pr, item("a"), "inbox", null, false)).toBe("#reviews");
    expect(backTarget(run, tab("reviews"), "reviews", null, false)).toBe("#reviews");
  });
  it("Settings goes back to the list it was opened from", () => {
    expect(backTarget(settings, tab("history"), "history", null, false)).toBe("#history");
    expect(backTarget(settings, item("a"), "inbox", null, false)).toBe("#inbox");
  });
});

describe("listOf: the list a back target is", () => {
  it("is the tab, Team for an orchestrator page", () => {
    expect(listOf("#inbox")).toBe("inbox");
    expect(listOf("#history")).toBe("history");
    expect(listOf("#reviews")).toBe("reviews");
    expect(listOf("#team")).toBe("team");
    expect(listOf("#orch.O3")).toBe("team");
  });
});

describe("backLabel", () => {
  it("names where back goes: the orchestrator, Queue for an item over the Inbox, else the list", () => {
    expect(backLabel("#orch.O3", "item")).toBe("O3");
    expect(backLabel("#inbox", "item")).toBe("Queue");
    expect(backLabel("#inbox", "settings")).toBe("Inbox");
    expect(backLabel("#reviews", "pr")).toBe("Reviews");
    expect(backLabel("#team", "orch")).toBe("Team");
  });
});

describe("savedNav: a history entry's own way back, kept on its state", () => {
  it("reads what route() saved, and nothing else", () => {
    expect(savedNav({ nav: { back: "#inbox", ret: "inbox", tab: "inbox", from: "#inbox" }, landed: true })).toEqual({ back: "#inbox", ret: "inbox", tab: "inbox", from: "#inbox" });
    expect(savedNav({ nav: { back: "#orch.O3", ret: "inbox", tab: "team", from: null } })).toEqual({ back: "#orch.O3", ret: "inbox", tab: "team", from: null });
    expect(savedNav({ nav: { back: "#inbox", ret: "inbox", from: null } })).toBeNull(); // from before the list was kept
    expect(savedNav(null)).toBeNull();
    expect(savedNav({ landed: true })).toBeNull();
    expect(savedNav({ nav: { back: "javascript:x", ret: "inbox", tab: "inbox", from: null } })).toBeNull();
    expect(savedNav({ nav: { back: "#inbox", ret: "nope", tab: "inbox", from: null } })).toBeNull();
  });
});

describe("upIsBack: going up returns to the entry before, so it steps back instead of adding one", () => {
  it("when the page was arrived at from where up goes", () => {
    expect(upIsBack({ back: "#inbox", ret: "inbox", tab: "inbox", from: "#inbox" })).toBe(true);
    expect(upIsBack({ back: "#reviews", ret: "inbox", tab: "inbox", from: "#item.a" })).toBe(false);
    expect(upIsBack({ back: "#inbox", ret: "inbox", tab: "inbox", from: null })).toBe(false); // the first page of the session
    expect(upIsBack(null)).toBe(false);
  });
});

describe("upIsBack: equivalent list URLs are the same page", () => {
  const nav = (back: string, from: string | null) => ({ back, ret: "inbox" as const, tab: "inbox" as const, from });
  it("a hashless entry (the desktop app at /) is the list it resolves to", () => {
    expect(upIsBack(nav("#inbox", "#"))).toBe(true);
  });
  it("the #/inbox alias is #inbox", () => {
    expect(upIsBack(nav("#inbox", "#/inbox"))).toBe(true);
    expect(upIsBack(nav("#/team", "#team"))).toBe(true);
    expect(upIsBack(nav("#orch.O3", "#/orch/O3"))).toBe(true);
  });
  it("different pages still aren't", () => {
    expect(upIsBack(nav("#inbox", "#team"))).toBe(false);
    expect(upIsBack(nav("#orch.O3", "#orch.O4"))).toBe(false);
    expect(upIsBack(nav("#inbox", "#item.a"))).toBe(false);
  });
});

describe("arrival: what an entry with no saved way back knows of the page before", () => {
  it("a navigation knows the page it came from", () => {
    expect(arrival(false, orch("O3"), "#inbox", true, "#orch.O3")).toEqual({ prev: orch("O3"), kept: "#inbox", rowOpened: true, from: "#orch.O3" });
  });
  it("Back or Forward to an entry made before this was kept (a legacy one) knows nothing: the page just left isn't its predecessor", () => {
    expect(arrival(true, orch("O3"), "#inbox", true, "#orch.O3")).toEqual({ prev: null, kept: null, rowOpened: false, from: null });
  });
});
