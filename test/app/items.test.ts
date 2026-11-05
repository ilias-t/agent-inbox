import { describe, expect, it } from "vitest";
import type { Doc, Item, Orchestrator } from "../../shared/types.ts";
import {
  agentChoice, answeredAt, baseOptions, decideConflict, evidenceOf, flattenItem, flattenOrch, fyiItems, headlineOf, isAnswered, labelFor,
  openItems, optionsFor, pastItems, prChip, recOf, sortedOrchs, type ItemRow, type OrchRow,
} from "../../src/lib/items.ts";

const item = (over: Partial<ItemRow> & { id: string }): ItemRow => ({ type: "decision", title: "t", status: "open", ...over }) as ItemRow;

describe("flattening docs", () => {
  const meta = { version: 3, created_at: "2026-10-07T00:00:00Z", updated_at: "2026-10-07T00:00:00Z", updated_by: "human:x" };
  it("items: data first, the doc id wins", () => {
    const d: Doc<Item> = { id: "p-x", data: { type: "proposal", title: "X", status: "open", id: "stale" } as Item, ...meta };
    expect(flattenItem(d)).toEqual({ type: "proposal", title: "X", status: "open", id: "p-x" });
  });
  it("items: the viewer's own snooze is the row's snoozed_until; one left on the doc from before is ignored", () => {
    const legacy = { snoozed_until: "2026-10-09T09:00:00.000Z", snoozed_by: "human:someone@else" };
    const d: Doc<Item> = { id: "p-x", data: { type: "proposal", title: "X", status: "open", ...legacy } as Item, ...meta };
    expect(flattenItem(d)).toEqual({ type: "proposal", title: "X", status: "open", id: "p-x" });
    expect(flattenItem(d, { other: "2026-10-08T09:00:00.000Z" })).toEqual({ type: "proposal", title: "X", status: "open", id: "p-x" });
    expect(flattenItem(d, { "p-x": "2026-10-08T09:00:00.000Z" })).toEqual({
      type: "proposal", title: "X", status: "open", id: "p-x", snoozed_until: "2026-10-08T09:00:00.000Z",
    });
  });
  it("orchestrators: id first", () => {
    const d: Doc<Orchestrator> = { id: "O3", data: { goal: "g", status: "running" }, ...meta };
    expect(flattenOrch(d)).toEqual({ id: "O3", goal: "g", status: "running" });
  });
});

describe("options", () => {
  it("proposal defaults to approve / reject, plus Other", () => {
    const i = item({ id: "a", type: "proposal" });
    expect(baseOptions(i)).toEqual({ list: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], implied: true });
    expect(optionsFor(i).list.map((o) => o.id)).toEqual(["approve", "reject", "other"]);
  });
  it("every other type defaults to ack, plus Other", () => {
    for (const type of ["decision", "blocker", "info", "pr_ready"] as const) {
      expect(optionsFor(item({ id: "a", type })).list.map((o) => o.id)).toEqual(["ack", "other"]);
    }
  });
  it("explicit options win, dropping a stray other and empty entries", () => {
    const i = item({ id: "a", options: [{ id: "pg", label: "Postgres" }, { id: "other", label: "x" }, null as never, { id: "", label: "" }] });
    const o = optionsFor(i);
    expect(o.implied).toBe(false);
    expect(o.list.map((x) => x.id)).toEqual(["pg", "other"]);
    expect(o.list[1].label).toBe("Other…");
  });
});

describe("Done on GitHub on a routine's ask", () => {
  const ask = item({ id: "review-bot-4736-product", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], review_pr: { routine: "review-bot", number: 4736 } });
  it("is offered before Other on an item with review_pr, and not elsewhere", () => {
    expect(optionsFor(ask).list.map((o) => o.id)).toEqual(["a", "b", "github", "other"]);
    expect(optionsFor(ask).list[2]).toMatchObject({ label: "Done on GitHub" });
    expect(optionsFor(item({ id: "x", options: [{ id: "a", label: "A" }] })).list.map((o) => o.id)).toEqual(["a", "other"]);
    expect(baseOptions(ask).list.map((o) => o.id)).toEqual(["a", "b"]);
  });
  it("labels as Done on GitHub", () => {
    expect(labelFor(ask, "github")).toBe("Done on GitHub");
  });
});

describe("labelFor", () => {
  const i = item({ id: "a", options: [{ id: "pg", label: "Postgres" }, { id: "nolabel", label: "" }] });
  it("resolves option ids and the special choices", () => {
    expect(labelFor(i, "pg")).toBe("Postgres");
    expect(labelFor(i, "nolabel")).toBe("nolabel");
    expect(labelFor(i, "other")).toBe("Other");
    expect(labelFor(i, "override")).toBe("Overridden");
    expect(labelFor(i, "mystery")).toBe("mystery");
    expect(labelFor(i, "withdrawn")).toBe("Withdrawn");
    expect(labelFor(i, "merged")).toBe("PR merged");
    expect(labelFor(i, "closed")).toBe("PR closed");
    expect(labelFor(i, "constructor")).toBe("constructor");
    expect(labelFor(item({ id: "w", options: [{ id: "withdrawn", label: "Pull it" }] }), "withdrawn")).toBe("Pull it");
    expect(labelFor(i, undefined)).toBe("");
    expect(labelFor(item({ id: "b", type: "proposal" }), "approve")).toBe("Approve");
    expect(labelFor(item({ id: "c", type: "info" }), "ack")).toBe("Acknowledge");
  });
});

describe("decideConflict: what a 409 on a decision tells the page", () => {
  const shown = item({ id: "a", type: "proposal", title: "Rename a variable" });
  it("still open: the item changed since it was shown, so the human reviews and decides again", () => {
    const now = item({ id: "a", type: "proposal", title: "Drop the prod database" });
    expect(decideConflict(shown, now)).toEqual({
      changed: true,
      msg: "This item changed since you opened it — review and decide again.",
    });
  });
  it("no longer open: someone else got there first", () => {
    const now = item({ id: "a", type: "proposal", status: "decided", decision: { choice: "reject", decided_at: "T" } });
    expect(decideConflict(shown, now)).toEqual({ changed: false, msg: "Already decided (Reject) elsewhere." });
    expect(decideConflict(shown, item({ id: "a", status: "archived" }))).toEqual({ changed: false, msg: "Already archived elsewhere." });
  });
});

describe("recOf", () => {
  it("reads the full recommendation", () => {
    expect(recOf(item({ id: "a", recommendation: { option: "pg", confidence: "high", why: "fast" } })))
      .toEqual({ option: "pg", confidence: "high", why: "fast", full: true });
  });
  it("drops an unknown confidence", () => {
    expect(recOf(item({ id: "a", recommendation: { option: "pg", confidence: "huge" as never } }))?.confidence).toBeNull();
  });
  it("falls back to legacy recommended", () => {
    expect(recOf(item({ id: "a", recommended: "approve" }))).toEqual({ option: "approve", confidence: null, why: "", full: false });
  });
  it("prefers recommendation over recommended, and is null with neither", () => {
    expect(recOf(item({ id: "a", recommended: "x", recommendation: { option: "y" } }))?.option).toBe("y");
    expect(recOf(item({ id: "a" }))).toBeNull();
  });
});

describe("sorting", () => {
  const items = [
    item({ id: "n-old", priority: "normal", created_at: "2026-10-01T00:00:00Z" }),
    item({ id: "h-new", priority: "high", created_at: "2026-10-06T00:00:00Z" }),
    item({ id: "low", priority: "low", created_at: "2026-09-01T00:00:00Z" }),
    item({ id: "n-new", created_at: "2026-10-05T00:00:00Z" }),
    item({ id: "h-old", priority: "high", created_at: "2026-10-02T00:00:00Z" }),
    item({ id: "auto-old", type: "auto_decided", created_at: "2026-10-01T00:00:00Z", decision: { choice: "a", decided_at: "x" } }),
    item({ id: "auto-new", type: "auto_decided", created_at: "2026-10-03T00:00:00Z", decision: { choice: "a", decided_at: "x" } }),
    item({ id: "dec", status: "decided", decision: { choice: "ack", decided_at: "2026-10-04T00:00:00Z" }, updated_at: "2026-10-04T00:00:00Z" }),
    item({ id: "proc", status: "processing", decision: { choice: "ack", decided_at: "2026-10-06T00:00:00Z" } }),
    item({ id: "arch", status: "archived", updated_at: "2026-10-05T00:00:00Z" }),
  ];
  it("open asks: priority, then oldest first; never auto_decided", () => {
    expect(openItems(items).map((i) => i.id)).toEqual(["h-old", "h-new", "n-old", "n-new", "low"]);
  });
  it("FYI: open auto_decided, newest first", () => {
    expect(fyiItems(items).map((i) => i.id)).toEqual(["auto-new", "auto-old"]);
  });
  it("past: decided, processing and archived, newest decision first", () => {
    expect(pastItems(items).map((i) => i.id)).toEqual(["proc", "arch", "dec"]);
  });
  it("orchestrators: by status order, then id numerically", () => {
    const os: OrchRow[] = [{ id: "O10", status: "running" }, { id: "O2", status: "running" }, { id: "O1", status: "done" }, { id: "O5", status: "blocked" }, { id: "O7" }];
    expect(sortedOrchs(os).map((o) => o.id)).toEqual(["O5", "O2", "O10", "O1", "O7"]);
  });
});

describe("answered dot", () => {
  const base = { id: "a", qa_answered_at: "2026-10-07T12:00:00Z", qa_last_at: "2026-10-07T11:00:00Z" };
  const answered = Date.parse(base.qa_answered_at);
  it("shows when the answer is newer than the question and the last look", () => {
    expect(isAnswered(item(base), {})).toBe(true);
    expect(isAnswered(item(base), { a: answered - 1 })).toBe(true);
  });
  it("hides once the viewer has looked since the answer", () => {
    expect(isAnswered(item(base), { a: answered })).toBe(false);
  });
  it("hides while a question is pending or newer than the answer", () => {
    expect(isAnswered(item({ ...base, qa_pending: true }), {})).toBe(false);
    expect(isAnswered(item({ ...base, qa_last_at: "2026-10-07T13:00:00Z" }), {})).toBe(false);
    expect(answeredAt(item({ id: "b" }))).toBeNaN();
  });
});

describe("misc", () => {
  it("headline prefers the question", () => {
    expect(headlineOf(item({ id: "a", title: "T", question: "  Q?  " }))).toBe("Q?");
    expect(headlineOf(item({ id: "a", title: "T", question: " " }))).toBe("T");
  });
  it("agentChoice reads override_of after an override", () => {
    expect(agentChoice(item({ id: "a", decision: { choice: "x", decided_at: "" } }))).toBe("x");
    expect(agentChoice(item({ id: "a", decision: { choice: "override", decided_at: "" }, override_of: "x" }))).toBe("x");
  });
  it("evidence falls back to links", () => {
    const links = [{ label: "L", url: "https://l" }];
    expect(evidenceOf(item({ id: "a", links, evidence: [{ label: "bad", url: "javascript:x" }] }))).toEqual(links);
    expect(evidenceOf(item({ id: "a", links, evidence: [{ label: "E", url: "https://e" }] }))).toEqual([{ label: "E", url: "https://e" }]);
  });
  it("pr chip labels known states only", () => {
    expect(prChip(item({ id: "a", pr_state: "merged" }))).toContain(">PR merged<");
    expect(prChip(item({ id: "a", pr_state: "changes_requested" }), true)).toContain(">changes<");
    expect(prChip(item({ id: "a", pr_state: '"><script>' as never }))).toBe("");
    expect(prChip(item({ id: "a" }))).toBe("");
  });
});
