import { describe, expect, it } from "vitest";
import { StaleTabs } from "../../src/lib/tabs.ts";

type T = "inbox" | "team" | "history";
const tabs = () => new StaleTabs<T>(["inbox", "team", "history"]);

describe("StaleTabs: index lists render only while shown", () => {
  it("builds the shown tab's list on a render", () => {
    expect(tabs().render("inbox", "inbox")).toBe(true);
  });
  it("skips a hidden tab's list (and every tab's while a detail page shows)", () => {
    const t = tabs();
    expect(t.render("history", "inbox")).toBe(false);
    expect(t.render("inbox", null)).toBe(false);
  });
  it("builds a tab on show when a render skipped it since it was last built", () => {
    const t = tabs();
    t.render("history", "history");
    t.render("history", "inbox");
    expect(t.show("history", false)).toBe(true);
  });
  it("doesn't rebuild a tab on show when nothing asked for a render since it was built", () => {
    const t = tabs();
    t.render("history", "history");
    t.render("inbox", "inbox");
    expect(t.show("history", false)).toBe(false);
  });
  it("builds a tab on its first show", () => {
    expect(tabs().show("team", false)).toBe(true);
  });
  it("builds every tab on show after they're all marked stale (a detail page was opened: what was viewed changed)", () => {
    const t = tabs();
    t.render("inbox", "inbox");
    t.render("history", "history");
    t.markAll();
    expect(t.show("history", false)).toBe(true);
    expect(t.show("inbox", false)).toBe(true);
  });
  it("builds on show when forced (back from a detail page: the answered dots may have changed)", () => {
    const t = tabs();
    t.render("inbox", "inbox");
    expect(t.show("inbox", true)).toBe(true);
  });
});
