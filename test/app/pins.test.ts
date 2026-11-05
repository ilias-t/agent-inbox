// Pins (src/lib/pins.ts): which rows go in a list's Pinned group, in what order, and what a row or page stands for.
import { describe, expect, it } from "vitest";
import type { ReviewPrRow } from "../../shared/types.ts";
import type { ItemRow } from "../../src/lib/items.ts";
import { byPin, isPinned, pinHistory, pinInbox, pinKey, pinOfHref, pinPrs, pinnedRefs, splitPinned } from "../../src/lib/pins.ts";

const pins = {
  "item:a": "2026-10-09T10:00:00.000Z",
  "item:c": "2026-10-09T12:00:00.000Z",
  "orch:O2": "2026-10-09T11:00:00.000Z",
  "pr:review-bot/812": "2026-10-09T09:00:00.000Z",
  "pr:other/7": "2026-10-09T13:00:00.000Z",
};

describe("pinKey and isPinned", () => {
  it("name a thing as <kind>:<ref>", () => {
    expect(pinKey("item", "a")).toBe("item:a");
    expect(pinKey("pr", "review-bot/812")).toBe("pr:review-bot/812");
    expect(isPinned(pins, "item:a")).toBe(true);
    expect(isPinned(pins, "item:b")).toBe(false);
    expect(isPinned(pins, "toString")).toBe(false); // own keys only
  });
});

describe("splitPinned", () => {
  const rows = ["a", "b", "c", "d"].map((id) => ({ id }));
  it("takes the pinned rows out, newest pin first, and keeps the rest in their order", () => {
    const { pinned, rest } = splitPinned(rows, (r) => pinKey("item", r.id), pins);
    expect(pinned.map((r) => r.id)).toEqual(["c", "a"]);
    expect(rest.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("with no pins, pins nothing", () => {
    const { pinned, rest } = splitPinned(rows, (r) => pinKey("item", r.id), {});
    expect(pinned).toEqual([]);
    expect(rest).toBe(rows);
  });

  it("ties on the pin time go by key, so the order is stable", () => {
    const same = { "item:b": "2026-10-09T10:00:00.000Z", "item:a": "2026-10-09T10:00:00.000Z" };
    expect(splitPinned(rows, (r) => pinKey("item", r.id), same).pinned.map((r) => r.id)).toEqual(["a", "b"]);
    expect(byPin(same, ["item:b", "item:a"])).toEqual(["item:a", "item:b"]);
  });
});

describe("pinnedRefs", () => {
  it("lists one kind's refs, newest pin first", () => {
    expect(pinnedRefs(pins, "item")).toEqual(["c", "a"]);
    expect(pinnedRefs(pins, "orch")).toEqual(["O2"]);
    expect(pinnedRefs(pins, "pr")).toEqual(["other/7", "review-bot/812"]);
  });
});

describe("pinOfHref", () => {
  it("reads an item, orchestrator or PR row's link as its pin", () => {
    expect(pinOfHref("#item.a%2Fb", null)).toBe("item:a/b");
    expect(pinOfHref("#orch.O3", null)).toBe("orch:O3");
    expect(pinOfHref("#pr.review-bot.812", null)).toBe("pr:review-bot/812");
  });
  it("a PR link without its routine is the routine shown's", () => {
    expect(pinOfHref("#pr.812", "review-bot")).toBe("pr:review-bot/812");
    expect(pinOfHref("#pr.812", null)).toBeNull();
  });
  it("anything else pins nothing (a run, a tab)", () => {
    expect(pinOfHref("#run.2026-10-08T180000Z", "review-bot")).toBeNull();
    expect(pinOfHref("#inbox", null)).toBeNull();
    expect(pinOfHref("", null)).toBeNull();
  });
});

describe("the lists' Pinned groups", () => {
  const item = (id: string, over: Partial<ItemRow> = {}): ItemRow => ({ id, type: "decision", title: id, status: "open", ...over }) as ItemRow;
  const p = { "item:a2": "2026-10-09T10:00:00.000Z", "item:f1": "2026-10-09T11:00:00.000Z", "item:h1": "2026-10-09T09:00:00.000Z", "item:x9": "2026-10-09T12:00:00.000Z" };

  it("Inbox: pinned asks and FYIs leave their groups for Pinned, newest pin first", () => {
    const asks = [item("a1"), item("a2"), item("a3")], fyi = [item("f1", { type: "auto_decided" }), item("f2", { type: "auto_decided" })];
    const g = pinInbox(asks, fyi, p);
    expect(g.pinned.map((i) => i.id)).toEqual(["f1", "a2"]);
    expect(g.asks.map((i) => i.id)).toEqual(["a1", "a3"]);
    expect(g.fyi.map((i) => i.id)).toEqual(["f2"]);
  });

  it("History: pinned past items go on top, loaded or fetched on their own, once each, and the day groups lose them", () => {
    const shown = [item("h2", { status: "archived" }), item("h1", { status: "decided" }), item("h3", { status: "archived" })];
    const fetched = [item("x9", { status: "archived" }), item("h1", { status: "decided" })];
    const g = pinHistory(shown, fetched, p);
    expect(g.pinned.map((i) => i.id)).toEqual(["x9", "h1"]);
    expect(g.rest.map((i) => i.id)).toEqual(["h2", "h3"]);
  });

  const pr = (routine: string, n: number, gone: string | null = null) => ({ routine, number: n, gone_at: gone }) as ReviewPrRow;
  const pp = { "pr:rv/812": "2026-10-09T10:00:00.000Z", "pr:rv/700": "2026-10-09T11:00:00.000Z", "pr:rv/5": "2026-10-09T12:00:00.000Z", "pr:other/812": "2026-10-09T13:00:00.000Z" };

  it("Reviews: the routine's pinned PRs, gone ones too, leave the status groups; others' pins don't count", () => {
    const rows = [pr("rv", 900), pr("rv", 812), pr("rv", 700, "2026-10-08T00:00:00.000Z")];
    const g = pinPrs(rows, "rv", pp);
    expect(g.pinned.map((r) => r.number)).toEqual([700, 812]);
    expect(g.rest.map((r) => r.number)).toEqual([900]);
    // Pinned but not in the list (gone longer than the tab keeps them): fetched on their own.
    expect(g.missing).toEqual([5]);
  });
});
