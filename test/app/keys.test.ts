import { describe, expect, it } from "vitest";
import { SETTLE_MS, SHORTCUTS, keyAction, keyHints, settling, type KeyContext } from "../../src/lib/keys.ts";

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({ view: "item", typing: false, onChoice: false, pendingG: false, settling: false, ...over });
const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}) => ({ key: k, ...mods });

describe("keyAction on an item page", () => {
  it("moves between items", () => {
    expect(keyAction(key("j"), ctx())).toEqual({ type: "next" });
    expect(keyAction(key("ArrowDown"), ctx())).toEqual({ type: "next" });
    expect(keyAction(key("k"), ctx())).toEqual({ type: "prev" });
    expect(keyAction(key("ArrowUp"), ctx())).toEqual({ type: "prev" });
  });
  it("j and k mean down and up: ← and → no longer move between items", () => {
    expect(keyAction(key("ArrowRight"), ctx())).toBeNull();
    expect(keyAction(key("ArrowLeft"), ctx())).toBeNull();
  });
  it("n goes to the note, live right after arriving, and not while typing or off an item page", () => {
    expect(keyAction(key("n"), ctx())).toEqual({ type: "note" });
    expect(keyAction(key("n"), ctx({ settling: true }))).toEqual({ type: "note" });
    expect(keyAction(key("n"), ctx({ typing: true }))).toBeNull();
    expect(keyAction(key("n"), ctx({ view: "index" }))).toBeNull();
    expect(keyAction(key("n"), ctx({ view: "orch" }))).toBeNull();
  });
  it("chooses options 1-9, but not 0", () => {
    expect(keyAction(key("1"), ctx())).toEqual({ type: "choose", n: 1 });
    expect(keyAction(key("9"), ctx())).toEqual({ type: "choose", n: 9 });
    expect(keyAction(key("0"), ctx())).toBeNull();
  });
  it("submits with Ctrl/Cmd+Enter outside text fields, and with Enter only from the checked option button", () => {
    expect(keyAction(key("Enter", { metaKey: true }), ctx())).toEqual({ type: "submit" });
    expect(keyAction(key("Enter", { ctrlKey: true }), ctx())).toEqual({ type: "submit" });
    expect(keyAction(key("Enter"), ctx({ onChoice: true }))).toEqual({ type: "submit" });
    expect(keyAction(key("Enter"), ctx())).toBeNull(); // a focused link or button keeps its native Enter
  });
  it("asks, accepts, overrides and goes back", () => {
    expect(keyAction(key("a"), ctx())).toEqual({ type: "ask" });
    expect(keyAction(key("y"), ctx())).toEqual({ type: "accept" });
    expect(keyAction(key("o"), ctx())).toEqual({ type: "override" });
    expect(keyAction(key("u"), ctx())).toEqual({ type: "back" });
    expect(keyAction(key("Escape"), ctx())).toEqual({ type: "back" });
  });
});

describe("keyAction while typing", () => {
  const typing = ctx({ typing: true });
  it("Ctrl/Cmd+Enter sends only from the note or the question box; other fields keep it", () => {
    expect(keyAction(key("Enter", { ctrlKey: true }), ctx({ typing: true, sendField: true }))).toEqual({ type: "submit" });
    expect(keyAction(key("Enter", { metaKey: true }), ctx({ typing: true, sendField: true }))).toEqual({ type: "submit" });
    // e.g. the assignee's email field or the tick note: no decision from there
    expect(keyAction(key("Enter", { ctrlKey: true }), ctx({ typing: true }))).toBeNull();
    expect(keyAction(key("Enter", { metaKey: true }), ctx({ typing: true, sendField: false }))).toBeNull();
  });
  it("lets every plain key through to the field", () => {
    for (const k of ["j", "k", "n", "1", "a", "y", "o", "u", "?", "g", "Enter", "ArrowUp", "ArrowDown"]) {
      expect(keyAction(key(k), typing), k).toBeNull();
    }
  });
  it("keeps the send chord and Esc", () => {
    expect(keyAction(key("Enter", { metaKey: true }), ctx({ typing: true, sendField: true }))).toEqual({ type: "submit" });
    expect(keyAction(key("Escape"), typing)).toEqual({ type: "blur" });
  });
  it("ignores keys during IME composition", () => {
    expect(keyAction(key("Enter", { metaKey: true, isComposing: true }), ctx({ typing: true, sendField: true }))).toBeNull();
  });
  it("doesn't submit from a text field outside an item page", () => {
    expect(keyAction(key("Enter", { ctrlKey: true }), ctx({ view: "other", typing: true, sendField: true }))).toBeNull();
  });
});

describe("keyAction on a held key", () => {
  it("repeats moves but not actions", () => {
    expect(keyAction({ key: "j", repeat: true }, ctx())).toEqual({ type: "next" });
    expect(keyAction({ key: "ArrowDown", repeat: true }, ctx({ view: "index" }))).toEqual({ type: "rowNext" });
    expect(keyAction({ key: "Enter", repeat: true }, ctx({ onChoice: true }))).toBeNull();
    expect(keyAction({ key: "Enter", metaKey: true, repeat: true }, ctx())).toBeNull();
    expect(keyAction({ key: "y", repeat: true }, ctx())).toBeNull();
    expect(keyAction({ key: "1", repeat: true }, ctx())).toBeNull();
  });
});

describe("keyAction right after an auto-advance", () => {
  const settled = ctx({ settling: true });
  it("drops decision keys, so a double press can't act on the item just landed on", () => {
    expect(keyAction(key("y"), settled)).toBeNull();
    expect(keyAction(key("o"), settled)).toBeNull();
    expect(keyAction(key("1"), settled)).toBeNull();
    expect(keyAction(key("Enter", { metaKey: true }), settled)).toBeNull();
    expect(keyAction(key("Enter", { ctrlKey: true }), ctx({ settling: true, typing: true }))).toBeNull();
    expect(keyAction(key("Enter"), ctx({ settling: true, onChoice: true }))).toBeNull();
  });
  it("keeps moving, asking, going back and help live", () => {
    expect(keyAction(key("j"), settled)).toEqual({ type: "next" });
    expect(keyAction(key("k"), settled)).toEqual({ type: "prev" });
    expect(keyAction(key("u"), settled)).toEqual({ type: "back" });
    expect(keyAction(key("Escape"), settled)).toEqual({ type: "back" });
    expect(keyAction(key("?"), settled)).toEqual({ type: "help" });
    expect(keyAction(key("a"), settled)).toEqual({ type: "ask" });
  });
  it("settles for SETTLE_MS after the advance, and not before any advance", () => {
    expect(SETTLE_MS).toBe(400);
    expect(settling(10_000, 10_000)).toBe(true);
    expect(settling(10_000, 10_399)).toBe(true);
    expect(settling(10_000, 10_400)).toBe(false);
    expect(settling(0, 10_000)).toBe(false); // never advanced
  });
});

describe("keyAction with modifiers", () => {
  it("leaves browser and OS shortcuts alone", () => {
    expect(keyAction(key("k", { metaKey: true }), ctx())).toBeNull();
    expect(keyAction(key("1", { ctrlKey: true }), ctx())).toBeNull();
    expect(keyAction(key("ArrowLeft", { altKey: true }), ctx())).toBeNull();
    expect(keyAction(key("Enter", { metaKey: true, altKey: true }), ctx())).toBeNull();
  });
});

describe("keyAction elsewhere", () => {
  it("moves between rows on the index", () => {
    expect(keyAction(key("j"), ctx({ view: "index" }))).toEqual({ type: "rowNext" });
    expect(keyAction(key("ArrowUp"), ctx({ view: "index" }))).toEqual({ type: "rowPrev" });
    expect(keyAction(key("1"), ctx({ view: "index" }))).toBeNull();
    expect(keyAction(key("Escape"), ctx({ view: "index" }))).toBeNull();
  });
  it("goes back from the orchestrator and settings pages", () => {
    expect(keyAction(key("Escape"), ctx({ view: "other" }))).toEqual({ type: "back" });
    expect(keyAction(key("j"), ctx({ view: "other" }))).toBeNull();
  });
  it("steps through the Team list from an orchestrator page beside it, and goes back", () => {
    expect(keyAction(key("j"), ctx({ view: "orch" }))).toEqual({ type: "next" });
    expect(keyAction(key("ArrowUp"), ctx({ view: "orch" }))).toEqual({ type: "prev" });
    expect(keyAction(key("ArrowDown"), ctx({ view: "orch" }))).toEqual({ type: "next" });
    expect(keyAction(key("ArrowLeft"), ctx({ view: "orch" }))).toBeNull();
    expect(keyAction({ key: "j", repeat: true }, ctx({ view: "orch" }))).toEqual({ type: "next" });
    expect(keyAction(key("u"), ctx({ view: "orch" }))).toEqual({ type: "back" });
    expect(keyAction(key("1"), ctx({ view: "orch" }))).toBeNull();
    expect(keyAction(key("y"), ctx({ view: "orch" }))).toBeNull();
  });
  it("v switches Reviews between Runs and PRs, from the list and from a pane beside it", () => {
    expect(keyAction(key("v"), ctx({ view: "index" }))).toEqual({ type: "toggle" });
    expect(keyAction(key("v"), ctx({ view: "orch" }))).toEqual({ type: "toggle" });
    expect(keyAction(key("v"), ctx({ view: "item" }))).toBeNull();
    expect(SHORTCUTS.find((g) => g.group === "Inbox")!.rows.map(([k]) => k)).toContain("v");
  });
  it("goes to Reviews with g then r, listed under Anywhere", () => {
    expect(keyAction(key("r"), ctx({ view: "index", pendingG: true }))).toEqual({ type: "go", to: "reviews" });
    expect(SHORTCUTS.find((g) => g.group === "Anywhere")!.rows.map(([k]) => k)).toContain("g r");
  });
  it("switches views with g then i / t / h / s", () => {
    expect(keyAction(key("g"), ctx({ view: "index" }))).toEqual({ type: "g" });
    expect(keyAction(key("t"), ctx({ view: "index", pendingG: true }))).toEqual({ type: "go", to: "team" });
    expect(keyAction(key("i"), ctx({ pendingG: true }))).toEqual({ type: "go", to: "inbox" });
    expect(keyAction(key("h"), ctx({ view: "other", pendingG: true }))).toEqual({ type: "go", to: "history" });
    expect(keyAction(key("s"), ctx({ pendingG: true }))).toEqual({ type: "go", to: "settings" });
    expect(keyAction(key("j"), ctx({ pendingG: true }))).toEqual({ type: "next" }); // g then anything else: a normal key
  });
  it("opens the help overlay from any view", () => {
    for (const view of ["index", "item", "orch", "other"] as const) expect(keyAction(key("?"), ctx({ view }))).toEqual({ type: "help" });
  });
});

describe("keyAction: snooze and search", () => {
  it("s snoozes on an item page", () => {
    expect(keyAction(key("s"), ctx())).toEqual({ type: "snooze" });
  });
  it("s waits out the settle guard and a held key, like the decision keys", () => {
    expect(keyAction(key("s"), ctx({ settling: true }))).toBeNull();
    expect(keyAction({ key: "s", repeat: true }, ctx())).toBeNull();
  });
  it("s belongs to a text field while typing, and g s still goes to Settings", () => {
    expect(keyAction(key("s"), ctx({ typing: true }))).toBeNull();
    expect(keyAction(key("s"), ctx({ pendingG: true }))).toEqual({ type: "go", to: "settings" });
  });
  it("/ focuses the History search from a list, not from a field or a detail page", () => {
    expect(keyAction(key("/"), ctx({ view: "index" }))).toEqual({ type: "search" });
    expect(keyAction(key("/"), ctx({ view: "index", typing: true }))).toBeNull();
    expect(keyAction(key("/"), ctx({ view: "item" }))).toBeNull();
  });
  it("the ? overlay lists both", () => {
    const rows = SHORTCUTS.flatMap((g) => g.rows.map(([k]) => k));
    expect(rows).toContain("s");
    expect(rows).toContain("/");
  });
});

describe("keyAction: pin", () => {
  it("p pins or unpins the item, orchestrator or PR open, and the focused row in a list", () => {
    expect(keyAction(key("p"), ctx())).toEqual({ type: "pin" });
    expect(keyAction(key("p"), ctx({ view: "orch" }))).toEqual({ type: "pin" });
    expect(keyAction(key("p"), ctx({ view: "index" }))).toEqual({ type: "pin" });
    expect(keyAction(key("p"), ctx({ view: "other" }))).toEqual({ type: "pin" });
  });
  it("p belongs to a text field while typing, isn't held down, and doesn't wait out the settle guard", () => {
    expect(keyAction(key("p"), ctx({ typing: true }))).toBeNull();
    expect(keyAction({ key: "p", repeat: true }, ctx())).toBeNull();
    expect(keyAction(key("p"), ctx({ settling: true }))).toEqual({ type: "pin" });
    expect(keyAction(key("p", { ctrlKey: true }), ctx())).toBeNull();
  });
  it("the ? overlay lists it for the item page and for lists", () => {
    for (const g of ["Item page", "Inbox"]) expect(SHORTCUTS.find((x) => x.group === g)!.rows.map(([k]) => k)).toContain("p");
  });
});

describe("SHORTCUTS", () => {
  it("lists every group with at least one row", () => {
    expect(SHORTCUTS.map((g) => g.group)).toEqual(["Item page", "Inbox", "Anywhere"]);
    for (const g of SHORTCUTS) expect(g.rows.length).toBeGreaterThan(0);
  });
});

describe("keyHints (the desk's hint bar)", () => {
  const moves = [{ keys: ["j", "↓"], label: "Next" }, { keys: ["k", "↑"], label: "Previous" }];
  const back = { keys: ["u", "Esc"], label: "Back" };
  it("names an open decision's everyday keys, in the help list's order", () => {
    expect(keyHints("decide")).toEqual([
      ...moves,
      { keys: ["1–9"], label: "Choose" },
      { keys: ["Ctrl/⌘+↵"], label: "Submit" },
      { keys: ["n"], label: "Note" },
      { keys: ["a"], label: "Ask" },
      { keys: ["s"], label: "Snooze" },
      { keys: ["p"], label: "Pin" },
      back,
    ]);
    expect(keyHints()).toEqual(keyHints("decide"));
  });
  it("offers Looks good and Override on an FYI item instead of choosing and submitting", () => {
    expect(keyHints("auto").map((h) => h.label)).toEqual(["Next", "Previous", "Ask", "Looks good", "Override", "Snooze", "Pin", "Back"]);
  });
  it("leaves out Snooze and Pin where the session can't snooze or pin (a token's)", () => {
    expect(keyHints("decide", false).map((h) => h.label)).toEqual(["Next", "Previous", "Choose", "Submit", "Note", "Ask", "Back"]);
    expect(keyHints("auto", false).map((h) => h.label)).not.toContain("Snooze");
    expect(keyHints("view", false)).toEqual([...moves, back]);
  });
  it("shows the chord for Submit: Enter alone submits only from the checked option, and focus arrives on the title", () => {
    expect(keyAction(key("Enter"), ctx({ onChoice: false }))).toBeNull();
    expect(keyAction(key("Enter", { ctrlKey: true }), ctx({ onChoice: false }))).toEqual({ type: "submit" });
    expect(keyAction(key("Enter", { metaKey: true }), ctx({ onChoice: false }))).toEqual({ type: "submit" });
  });
  it("keeps to moving (and asking) on a closed item, and to moving for a viewer", () => {
    expect(keyHints("closed").map((h) => h.label)).toEqual(["Next", "Previous", "Ask", "Pin", "Back"]);
    expect(keyHints("view")).toEqual([...moves, { keys: ["p"], label: "Pin" }, back]);
  });
  it("shows only keys that do what the bar says on an item page", () => {
    const real: Record<string, string> = { "↓": "ArrowDown", "↑": "ArrowUp", "1–9": "1", Esc: "Escape" };
    const want: Record<string, string> = { Next: "next", Previous: "prev", Choose: "choose", Submit: "submit", Note: "note", Ask: "ask", "Looks good": "accept", Override: "override", Snooze: "snooze", Pin: "pin", Back: "back" };
    // Focus on no option: what the viewer has on arriving at an item (the title).
    for (const h of [...keyHints("decide"), ...keyHints("auto")]) {
      for (const k of h.keys) {
        const ev = k === "Ctrl/⌘+↵" ? [key("Enter", { ctrlKey: true }), key("Enter", { metaKey: true })] : [key(real[k] ?? k)];
        for (const e of ev) expect(keyAction(e, ctx({ onChoice: false }))?.type).toBe(want[h.label]);
      }
    }
  });
});
