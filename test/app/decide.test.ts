import { describe, expect, it } from "vitest";
import { decisionPrint, effectiveChoice, progressView, recMoved, submitState } from "../../src/lib/decide.ts";

describe("submitState: the Submit button, in the form and in the phone's bottom bar", () => {
  it("keeps the label 'Submit' before a choice and says what to do as help text", () => {
    expect(submitState({}, false, "")).toEqual({ label: "Submit", help: "Choose an option above.", enabled: false });
  });

  it("names the chosen option", () => {
    expect(submitState({ choice: "keep" }, false, "Keep triggers")).toEqual({ label: "Submit: Keep triggers", help: "", enabled: true });
  });

  it("Other needs a note first", () => {
    expect(submitState({ choice: "other", note: "  " }, false, "Other…")).toEqual({ label: "Submit: Other…", help: "Write a note to send Other.", enabled: false });
    expect(submitState({ choice: "other", note: "Do X" }, false, "Other…").enabled).toBe(true);
  });

  it("is disabled while saving", () => {
    expect(submitState({ choice: "keep" }, true, "Keep triggers")).toEqual({ label: "Saving…", help: "", enabled: false });
  });
});

describe("effectiveChoice: the recommendation pre-selected until the viewer picks", () => {
  const ids = ["keep", "worker", "other"];

  it("pre-selects the recommended option when nothing is chosen yet", () => {
    expect(effectiveChoice({}, "keep", ids, true)).toBe("keep");
  });

  it("the viewer's own choice wins", () => {
    expect(effectiveChoice({ choice: "worker" }, "keep", ids, true)).toBe("worker");
    expect(effectiveChoice({ choice: "other" }, "keep", ids, true)).toBe("other");
  });

  it("a choice cleared after a 409 stays cleared: the recommendation doesn't come back", () => {
    expect(effectiveChoice({ choice: null }, "keep", ids, true)).toBeUndefined();
  });

  it("only a draft without a choice key falls back (a note alone doesn't count as a choice)", () => {
    expect(effectiveChoice({ note: "hm" } as { choice?: string | null }, "keep", ids, true)).toBe("keep");
  });

  it("nothing for someone who can't decide it (viewers, closed and auto-decided items)", () => {
    expect(effectiveChoice({}, "keep", ids, false)).toBeUndefined();
  });

  it("nothing when there's no recommendation, it names no shown option, or it says Other", () => {
    expect(effectiveChoice({}, null, ids, true)).toBeUndefined();
    expect(effectiveChoice({}, undefined, ids, true)).toBeUndefined();
    expect(effectiveChoice({}, "ship-it", ids, true)).toBeUndefined();
    expect(effectiveChoice({}, "other", ids, true)).toBeUndefined();
  });
});

describe("progressView: segments while they fit, then one bar", () => {
  it("one segment per item up to the cap", () => {
    expect(progressView(0, 5)).toEqual({ segs: 5, fill: 0 });
    expect(progressView(11, 12)).toEqual({ segs: 12, fill: 0 });
  });

  it("past the cap, a bar filled to the nearest 5%", () => {
    expect(progressView(0, 40)).toEqual({ segs: 0, fill: 5 });
    expect(progressView(19, 40)).toEqual({ segs: 0, fill: 50 });
    expect(progressView(39, 40)).toEqual({ segs: 0, fill: 100 });
    expect(progressView(0, 1000)).toEqual({ segs: 0, fill: 0 });
  });

  it("nothing for an item that isn't in the queue", () => {
    expect(progressView(-1, 5)).toBeNull();
    expect(progressView(0, 0)).toBeNull();
  });
});

describe("recMoved: a recommendation that changes under a pre-selection", () => {
  it("is false on the first render and while the recommendation stays", () => {
    expect(recMoved({}, "keep")).toBe(false);
    expect(recMoved({ recShown: "keep" }, "keep")).toBe(false);
  });

  it("is true when another option is recommended now, or none is", () => {
    expect(recMoved({ recShown: "keep" }, "worker")).toBe(true);
    expect(recMoved({ recShown: "keep" }, undefined)).toBe(true);
  });

  it("never once the viewer chose (or a 409 cleared the choice)", () => {
    expect(recMoved({ choice: "keep", recShown: "keep" }, "worker")).toBe(false);
    expect(recMoved({ choice: null, recShown: "keep" }, "worker")).toBe(false);
  });
});

describe("decisionPrint: what a choice was made on", () => {
  const opts = [
    { id: "approve", label: "Deploy", description: "Deploy to staging", consequence: "O1 ships it", tradeoff: "", reversible: true },
    { id: "reject", label: "Reject" },
  ];
  const base = decisionPrint("Ship it?", opts, "approve");

  it("is stable for the same content", () => {
    expect(decisionPrint("Ship it?", opts.map((o) => ({ ...o })), "approve")).toBe(base);
    expect(decisionPrint("  Ship it? ", opts, "approve")).toBe(base);
  });

  it("changes when an option means something else under the same id", () => {
    for (const change of [{ label: "Deploy now" }, { description: "Deploy to production" }, { consequence: "O1 ships it today" },
      { tradeoff: "No rollback" }, { reversible: false }]) {
      expect(decisionPrint("Ship it?", [{ ...opts[0], ...change }, opts[1]], "approve"), JSON.stringify(change)).not.toBe(base);
    }
  });

  it("changes with the question, the option list or the recommendation", () => {
    expect(decisionPrint("Ship it today?", opts, "approve")).not.toBe(base);
    expect(decisionPrint("Ship it?", opts.slice(0, 1), "approve")).not.toBe(base);
    expect(decisionPrint("Ship it?", opts, "reject")).not.toBe(base);
    expect(decisionPrint("Ship it?", opts, null)).not.toBe(base);
    // The rest of the subject: a proposal's title is all of it when there's no question.
    const withSubject = decisionPrint("", opts, "approve", ["Deploy to staging?", "Summary", "why", "high"]);
    expect(decisionPrint("", opts, "approve", ["Deploy to production?", "Summary", "why", "high"])).not.toBe(withSubject);
    expect(decisionPrint("", opts, "approve", ["Deploy to staging?", "Other summary", "why", "high"])).not.toBe(withSubject);
    expect(decisionPrint("", opts, "approve", ["Deploy to staging?", "Summary", "other why", "high"])).not.toBe(withSubject);
    expect(decisionPrint("", opts, "approve", [" Deploy to staging? ", "Summary", "why", "high"])).toBe(withSubject);
  });
});
