// Red means something is wrong: what needs you (counts, dots, the header badge, Needs you headings and chips) is in
// the accent blue, and red is kept for problems (a blocked orchestrator, requested changes, a closed PR, errors).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../src/style.css", import.meta.url).pathname, "utf8");
// Every declaration block of a rule whose selector list includes `sel` exactly.
function decls(sel: string): string {
  const out: string[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").map((s) => s.trim()).includes(sel)) out.push(m[2]);
  }
  return out.join(";");
}

describe("src/style.css colours", () => {
  it.each([
    ".mainnav .count.hot", ".mainnav .hotdot", ".ghead.high", ".pm.pd-high", ".pd.high", ".ocount", ".hbadge .need",
    ".bk.asks.has .blabel", ".smeta .prio.high", ".badge.rv-you",
  ])("%s (urgency) is the accent, not red", (sel) => {
    const d = decls(sel);
    expect(d, sel).toMatch(/var\(--accent(-text)?\)/);
    expect(d, sel).not.toMatch(/--(high|danger)/);
  });
  it.each([".badge.blocked", ".badge.ost.blocked", ".chip.prs.changes_requested", ".chip.prs.closed", ".badge.rv-chg", ".status.err"])(
    "%s (a problem) stays red", (sel) => {
      expect(decls(sel), sel).toMatch(/var\(--danger(-ink)?\)/);
    });
  it("has no urgency red left to reach for", () => {
    expect(CSS).not.toMatch(/--high\b|--high-ink|--glow-hi\b/);
  });
});
