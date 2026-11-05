import { describe, expect, it } from "vitest";
import { decisionLabel, endedChoice, rowMeta, verdictOf, type ItemRow, type MetaPart, type RowMetaOpts } from "../../src/lib/items.ts";

const item = (over: Partial<ItemRow> = {}): ItemRow => ({ id: "x", type: "decision", title: "t", status: "open", ...over }) as ItemRow;
const base: RowMetaOpts = { me: "me@example.com", people: [], seen: {} };
const kinds = (parts: MetaPart[]) => parts.map((p) => p.k);
const decision = (d: { choice: string; note?: string; ended?: string; by?: string }) => ({ decided_at: "2026-10-07T14:00:00Z", ...d }) as ItemRow["decision"];

describe("rowMeta: an open ask", () => {
  it("leads with the type word and the orchestrator, or Orchestrator for the orchestrator's own", () => {
    expect(rowMeta(item({ type: "blocker", orchestrator: "O2" }), base)).toEqual([{ k: "type", text: "Blocker" }, { k: "orch", text: "O2" }]);
    expect(rowMeta(item({ type: "proposal" }), base)).toEqual([{ k: "type", text: "Proposal" }, { k: "orch", text: "Orchestrator" }]);
    expect(rowMeta(item({ type: "pr_ready" }), base)[0]).toEqual({ k: "type", text: "PR ready" });
    expect(rowMeta(item({ type: "nonsense" as ItemRow["type"] }), base)[0]).toEqual({ k: "type", text: "Info" });
  });
  it("drops the orchestrator on its own page", () => {
    expect(kinds(rowMeta(item({ orchestrator: "O3" }), { ...base, hideOrch: true }))).toEqual(["type"]);
  });
  it("names the assignee: you (any case), or their name and initials", () => {
    expect(rowMeta(item({ assignee: "Me@Example.com" }), base).find((p) => p.k === "who")).toMatchObject({ me: true });
    expect(rowMeta(item({ assignee: "sam.lee@example.com" }), base).find((p) => p.k === "who"))
      .toEqual({ k: "who", me: false, name: "sam.lee", initials: "SL", email: "sam.lee@example.com" });
    const people = [{ email: "sam@example.com", name: "Sam Ortiz" }] as RowMetaOpts["people"];
    expect(rowMeta(item({ assignee: "sam@example.com" }), { ...base, people }).find((p) => p.k === "who")).toMatchObject({ name: "Sam Ortiz", initials: "SO" });
    // A token has no email: nobody is "you".
    expect(rowMeta(item({ assignee: "me@example.com" }), { ...base, me: null }).find((p) => p.k === "who")).toMatchObject({ me: false });
  });
  it("flags an answer the viewer hasn't seen, and a question waiting", () => {
    const answered = item({ qa_answered_at: "2026-10-07T14:10:00Z", qa_last_at: "2026-10-07T14:02:00Z" });
    expect(kinds(rowMeta(answered, base))).toContain("answered");
    expect(kinds(rowMeta(answered, { ...base, seen: { x: Date.parse("2026-10-07T14:11:00Z") } }))).not.toContain("answered");
    expect(kinds(rowMeta(item({ qa_pending: true }), base))).toContain("asked");
  });
  it("carries a full recommendation's confidence, then the PR state, in that order", () => {
    const ask = item({ orchestrator: "O1", recommendation: { option: "yes", confidence: "high", why: "" }, pr_state: "open" });
    expect(rowMeta(ask, base)).toEqual([
      { k: "type", text: "Decision" }, { k: "orch", text: "O1" }, { k: "conf", conf: "high", text: "High confidence" }, { k: "pr" },
    ]);
    expect(kinds(rowMeta(item({ recommended: "yes" }), base))).not.toContain("conf"); // a bare `recommended` has none
    expect(kinds(rowMeta(item({ pr_state: "bogus" as ItemRow["pr_state"] }), base))).not.toContain("pr");
  });
});

describe("rowMeta: an FYI (auto-decided) row", () => {
  const fyi = item({ type: "auto_decided", orchestrator: "O2", options: [{ id: "twice", label: "Retry twice" }], decision: decision({ choice: "twice" }) });
  it("says who chose what: no type word, no confidence", () => {
    expect(rowMeta(fyi, { ...base, fyi: true })).toEqual([{ k: "chose", who: "O2", text: "Retry twice" }]);
    expect(rowMeta({ ...fyi, orchestrator: undefined }, { ...base, fyi: true })[0]).toEqual({ k: "chose", who: "Orchestrator", text: "Retry twice" });
  });
  it("without a recorded choice, reads Decided for you, and still names the orchestrator", () => {
    expect(rowMeta(item({ type: "auto_decided", orchestrator: "O5" }), { ...base, fyi: true }))
      .toEqual([{ k: "type", text: "Decided for you" }, { k: "orch", text: "O5" }]);
    expect(rowMeta(item({ type: "auto_decided" }), { ...base, fyi: true })).toEqual([{ k: "type", text: "Decided for you" }, { k: "orch", text: "Orchestrator" }]);
    expect(kinds(rowMeta(item({ type: "auto_decided", orchestrator: "O5" }), { ...base, fyi: true, hideOrch: true }))).toEqual(["type"]);
  });
});

describe("rowMeta: a past row", () => {
  const opts = { ...base, past: true };
  it("decided: the verdict, the choice and the orchestrator", () => {
    const d = item({ status: "decided", orchestrator: "O3", options: [{ id: "keep", label: "Keep triggers" }], decision: decision({ choice: "keep" }) });
    expect(rowMeta(d, opts)).toEqual([
      { k: "verdict", text: "Decided", handling: false }, { k: "choice", text: "Keep triggers", choice: "keep" }, { k: "orch", text: "O3" },
    ]);
  });
  it("being handled, archived without a decision, accepted and overridden FYIs", () => {
    expect(rowMeta(item({ type: "proposal", status: "processing", decision: decision({ choice: "approve" }) }), opts).slice(0, 2))
      .toEqual([{ k: "verdict", text: "Being handled", handling: true }, { k: "choice", text: "Approve", choice: "approve" }]);
    expect(rowMeta(item({ status: "archived" }), opts).slice(0, 2))
      .toEqual([{ k: "verdict", text: "Archived", handling: false }, { k: "choice", text: "No decision", choice: "" }]);
    const auto = { type: "auto_decided", options: [{ id: "pin", label: "Pin 3.78" }] } as Partial<ItemRow>;
    expect(verdictOf(item({ ...auto, status: "archived", decision: decision({ choice: "pin" }) }))).toEqual({ verdict: "Accepted", label: "Pin 3.78", choice: "pin" });
    expect(verdictOf(item({ ...auto, status: "decided", override_of: "pin", decision: decision({ choice: "override", note: "Quarantine one test\nand file it" }) })))
      .toEqual({ verdict: "Overridden", label: "Quarantine one test", choice: "override" });
  });
  it("an overridden FYI the orchestrator has claimed is Being handled, as on the item page", () => {
    const claimed = item({
      type: "auto_decided", status: "processing", override_of: "pin", options: [{ id: "pin", label: "Pin 3.78" }],
      decision: decision({ choice: "override", note: "Quarantine one test" }),
    });
    expect(verdictOf(claimed)).toEqual({ verdict: "Being handled", label: "Quarantine one test", choice: "override" });
    expect(rowMeta(claimed, opts)[0]).toEqual({ k: "verdict", text: "Being handled", handling: true });
  });
  it("shows no confidence", () => {
    const d = item({ status: "decided", recommendation: { option: "yes", confidence: "high", why: "" }, decision: decision({ choice: "yes" }) });
    expect(kinds(rowMeta(d, opts))).not.toContain("conf");
  });
  it("withdrawn by its asker: Withdrawn, with the note's first line as the reason", () => {
    const w = item({ status: "archived", orchestrator: "review-bot", decision: decision({ choice: "withdrawn", ended: "withdrawn", note: "Hold cleared on GitHub\nreviewed at 14:02" }) });
    expect(verdictOf(w)).toEqual({ verdict: "Withdrawn", label: "Hold cleared on GitHub", choice: "withdrawn" });
    expect(rowMeta(w, opts)).toEqual([
      { k: "verdict", text: "Withdrawn", handling: false }, { k: "choice", text: "Hold cleared on GitHub", choice: "withdrawn" }, { k: "orch", text: "review-bot" },
    ]);
    // Without a note, no choice part: never "Withdrawn · Withdrawn" or "No decision".
    expect(rowMeta(item({ status: "archived", decision: decision({ choice: "withdrawn", ended: "withdrawn" }) }), opts).slice(0, 2))
      .toEqual([{ k: "verdict", text: "Withdrawn", handling: false }, { k: "orch", text: "Orchestrator" }]);
  });
  it("closed by the GitHub hook with its PR: Closed, and whether the PR merged", () => {
    const merged = item({ type: "pr_ready", status: "archived", decision: decision({ choice: "merged", ended: "merged", note: "Merged on GitHub", by: "hook:github" }) });
    expect(verdictOf(merged)).toEqual({ verdict: "Closed", label: "PR merged", choice: "merged" });
    const closed = item({ status: "archived", decision: decision({ choice: "closed", ended: "closed", note: "Closed on GitHub without merging", by: "hook:github" }) });
    expect(verdictOf(closed)).toEqual({ verdict: "Closed", label: "PR closed", choice: "closed" });
  });
  // An item may offer an option with one of those ids: the server's `ended` says what happened, not the id.
  describe("an option sharing the id", () => {
    const opts3 = [{ id: "withdrawn", label: "Pull the release" }, { id: "merged", label: "Merge it" }, { id: "closed", label: "Close it" }];
    it("a withdrawal still reads Withdrawn", () => {
      const w = item({ status: "archived", options: opts3, decision: decision({ choice: "withdrawn", ended: "withdrawn", note: "Moot now" }) });
      expect(endedChoice(w)).toBe("withdrawn");
      expect(verdictOf(w)).toEqual({ verdict: "Withdrawn", label: "Moot now", choice: "withdrawn" });
      expect(decisionLabel(w)).toBe("Withdrawn");
    });
    it.each([["merged", "PR merged"], ["closed", "PR closed"]])("a hook closure (%s) still reads Closed · %s", (c, label) => {
      const h = item({ status: "archived", options: opts3, decision: decision({ choice: c, ended: c, note: "on GitHub", by: "hook:github" }) });
      expect(verdictOf(h)).toEqual({ verdict: "Closed", label, choice: c });
      expect(decisionLabel(h)).toBe(label);
    });
    it("a human's pick of that option is an ordinary decision", () => {
      const d = item({ status: "decided", options: opts3, decision: decision({ choice: "withdrawn", by: "human:me@example.com" }) });
      expect(endedChoice(d)).toBeNull();
      expect(verdictOf(d)).toEqual({ verdict: "Decided", label: "Pull the release", choice: "withdrawn" });
      expect(decisionLabel(d)).toBe("Pull the release");
    });
  });
  it("old data: a hook merge from before `ended` still reads Closed · PR merged, by its author", () => {
    const old = item({ type: "pr_ready", status: "archived", decision: decision({ choice: "merged", note: "Merged on GitHub", by: "hook:github" }) });
    expect(verdictOf(old)).toEqual({ verdict: "Closed", label: "PR merged", choice: "merged" });
    // Not by the hook and no `ended`: whatever it is, nobody marked it as ended.
    expect(endedChoice(item({ status: "archived", decision: decision({ choice: "merged", by: "token:mgr" }) }))).toBeNull();
    expect(endedChoice(item({ type: "auto_decided", status: "archived", decision: decision({ choice: "withdrawn", ended: "withdrawn" }) }))).toBeNull();
  });
});

describe("rowMeta: a snoozed row", () => {
  it("says when it comes back and who it's assigned to; no type, orchestrator or PR", () => {
    const s = item({ orchestrator: "O1", pr_state: "open", snoozed_until: "2026-10-08T22:00:00Z", assignee: "me@example.com" });
    expect(kinds(rowMeta(s, { ...base, snoozed: true }))).toEqual(["wake", "who"]);
    expect(rowMeta(s, { ...base, snoozed: true })[0]).toEqual({ k: "wake", until: "2026-10-08T22:00:00Z" });
  });
});
