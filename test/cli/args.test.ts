import { describe, expect, it } from "vitest";
import { parseDecision, parseLink, parseOption, parseRecommend, parseSets, parseWhen } from "../../cli/args.mjs";
import { changeMatcher, isHumanActor } from "../../cli/wait.mjs";

describe("flag parsers", () => {
  it("--set: strings by default, JSON with :=", () => {
    expect(parseSets(["a=1", "b:=1", "c:=null", "d=x=y", "e:={\"k\":[true]}", "f="])).toEqual({
      a: "1",
      b: 1,
      c: null,
      d: "x=y",
      e: { k: [true] },
      f: "",
    });
    expect(() => parseSets(["noequals"])).toThrow(/key=value/);
    expect(() => parseSets(["=v"])).toThrow();
    expect(() => parseSets(["k:={bad"])).toThrow(/JSON/);
  });

  it("--option id:label[:description] keeps colons in the description", () => {
    expect(parseOption("a:Alpha:note: with colon")).toEqual({ id: "a", label: "Alpha", description: "note: with colon" });
    expect(parseOption("ack")).toEqual({ id: "ack", label: "ack" });
    expect(() => parseOption(":x")).toThrow();
  });

  it("--recommend option[:confidence[:why]]", () => {
    expect(parseRecommend("a")).toEqual({ option: "a" });
    expect(parseRecommend("a:low:because: reasons")).toEqual({ option: "a", confidence: "low", why: "because: reasons" });
    expect(() => parseRecommend("a:sure")).toThrow(/confidence/);
  });

  it("--link label=url, or a bare url", () => {
    expect(parseLink("PR #3=https://x.test/p?a=b")).toEqual({ label: "PR #3", url: "https://x.test/p?a=b" });
    expect(parseLink("https://x.test/p?a=b")).toEqual({ label: "https://x.test/p?a=b", url: "https://x.test/p?a=b" });
    expect(() => parseLink("just text")).toThrow();
  });

  it("--decision choice[:note]", () => {
    expect(parseDecision("a:why: this", "T")).toEqual({ choice: "a", note: "why: this", decided_at: "T" });
  });

  it("--next-tick ISO or +Nm/+Nh", () => {
    const now = Date.parse("2026-10-07T15:00:00.000Z");
    expect(parseWhen("+10m", now)).toBe("2026-10-07T15:10:00.000Z");
    expect(parseWhen("+2h", now)).toBe("2026-10-07T17:00:00.000Z");
    expect(parseWhen("2026-10-08T14:03:00Z", now)).toBe("2026-10-08T14:03:00.000Z");
    expect(() => parseWhen("soon", now)).toThrow();
  });
});

describe("change matching", () => {
  const c = { seq: 1, collection: "items", doc_id: "i", op: "update", version: 2, status: "decided", actor: "token:manager", at: "" };

  it("--human means human:* or hook:ntfy", () => {
    expect(isHumanActor("human:you@example.com")).toBe(true);
    expect(isHumanActor("hook:ntfy")).toBe(true);
    expect(isHumanActor("hook:github")).toBe(false);
    expect(isHumanActor("token:manager")).toBe(false);
  });

  it("filters AND together; --human and --actor OR", () => {
    expect(changeMatcher({})(c)).toBe(true);
    expect(changeMatcher({ human: true })(c)).toBe(false);
    expect(changeMatcher({ human: true, actors: ["token:"] })(c)).toBe(true);
    expect(changeMatcher({ statuses: ["open"] })(c)).toBe(false);
    expect(changeMatcher({ ids: ["i"], ops: ["update"], statuses: ["decided"] })(c)).toBe(true);
  });

  it("--human skips a human's Run-button request on a review routine; --actor still matches it", () => {
    const click = { ...c, collection: "reviews", doc_id: "review-bot", status: null, actor: "human:you@example.com" };
    expect(changeMatcher({ human: true })(click)).toBe(false);
    expect(changeMatcher({ human: true })({ ...click, collection: "items" })).toBe(true);
    expect(changeMatcher({ actors: ["human:"] })(click)).toBe(true);
  });
});
