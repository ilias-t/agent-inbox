import { describe, expect, it } from "vitest";
import { baseChoices, GITHUB_CHOICE, isReviewAsk, validChoices } from "../../shared/choices.ts";
import type { Item } from "../../shared/types.ts";

const item = (over: Partial<Item> = {}): Item => ({ type: "decision", title: "t", status: "open", ...over });

describe("baseChoices", () => {
  it("a proposal without options offers approve / reject, implied", () => {
    expect(baseChoices(item({ type: "proposal" }))).toEqual({
      list: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      implied: true,
    });
  });

  it("every other type without options offers ack, implied", () => {
    for (const type of ["decision", "blocker", "info", "pr_ready"] as const) {
      expect(baseChoices(item({ type }))).toEqual({ list: [{ id: "ack", label: "Acknowledge" }], implied: true });
    }
  });

  it("an empty options array falls back to the defaults", () => {
    expect(baseChoices(item({ type: "proposal", options: [] })).list.map((o) => o.id)).toEqual(["approve", "reject"]);
  });

  it("explicit options win, dropping a stray other and empty entries", () => {
    const options = [{ id: "pg", label: "Postgres" }, { id: "other", label: "x" }, null as never, { id: "", label: "" }];
    expect(baseChoices(item({ options }))).toEqual({ list: [{ id: "pg", label: "Postgres" }], implied: false });
  });
});

describe("validChoices", () => {
  it("is the base choices plus other", () => {
    expect(validChoices(item({ type: "proposal" }))).toEqual(["approve", "reject", "other"]);
    expect(validChoices(item())).toEqual(["ack", "other"]);
    expect(validChoices(item({ options: [{ id: "pg", label: "P" }, { id: "other", label: "x" }] }))).toEqual(["pg", "other"]);
  });

  it("auto_decided takes accept or override", () => {
    expect(validChoices(item({ type: "auto_decided", options: [{ id: "a", label: "A" }] }))).toEqual(["accept", "override"]);
  });
});

describe("Done on GitHub (a routine's ask)", () => {
  const ask = (over: Partial<Item> = {}) => item({ options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], review_pr: { routine: "review-bot", number: 4736 }, ...over });
  it("an item with review_pr also takes github, before other; others don't", () => {
    expect(isReviewAsk(ask())).toBe(true);
    expect(validChoices(ask())).toEqual(["a", "b", "github", "other"]);
    expect(validChoices(item({ options: [{ id: "a", label: "A" }] }))).toEqual(["a", "other"]);
    expect(validChoices(item({ review_pr: "4736" as never }))).toEqual(["ack", "other"]);
  });
  it("isn't a base choice, so the lock-screen buttons never show it", () => {
    expect(baseChoices(ask()).list.map((o) => o.id)).toEqual(["a", "b"]);
  });
  it("an option the item already calls github isn't offered twice", () => {
    expect(validChoices(ask({ options: [{ id: "github", label: "Mine" }, { id: "b", label: "B" }] }))).toEqual(["github", "b", "other"]);
  });
  it("has a fixed label", () => {
    expect(GITHUB_CHOICE).toEqual({ id: "github", label: "Done on GitHub" });
  });
});
