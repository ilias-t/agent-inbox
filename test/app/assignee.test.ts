import { describe, expect, it } from "vitest";
import type { Person } from "../../shared/types.ts";
import {
  assigneesInUse, filterAssignee, initials, isAssigneeFilter, personName, pushNote, type ItemRow,
} from "../../src/lib/items.ts";

const item = (id: string, assignee?: string): ItemRow => ({ id, type: "decision", title: "t", status: "open", assignee }) as ItemRow;
const items = [item("a", "alice@example.com"), item("b", "bob@example.com"), item("n")];
const ids = (list: ItemRow[]) => list.map((i) => i.id);

describe("assignee filter", () => {
  it("all keeps everything; unassigned keeps items without an assignee", () => {
    expect(ids(filterAssignee(items, "all", "alice@example.com"))).toEqual(["a", "b", "n"]);
    expect(ids(filterAssignee(items, "unassigned", "alice@example.com"))).toEqual(["n"]);
  });
  it("mine matches the signed-in email whatever its case, and nothing without one", () => {
    expect(ids(filterAssignee(items, "mine", "Alice@Example.com"))).toEqual(["a"]);
    expect(ids(filterAssignee(items, "mine", null))).toEqual([]);
  });
  it("only the three known values are filters", () => {
    expect(["all", "mine", "unassigned"].every(isAssigneeFilter)).toBe(true);
    expect([null, "", "Mine", "none"].some(isAssigneeFilter)).toBe(false);
  });
});

describe("when assignees show at all", () => {
  const alice: Person = { email: "alice@example.com", has_topic: true };
  it("only once someone is assigned or has set up notifications", () => {
    expect(assigneesInUse([item("n")], [])).toBe(false);
    expect(assigneesInUse([item("n"), item("a", "alice@example.com")], [])).toBe(true);
    expect(assigneesInUse([item("n")], [alice])).toBe(true);
  });
  it("says where pushes go only when people have topics to route to", () => {
    const bob: Person = { email: "bob@example.com", has_topic: false };
    expect(pushNote(undefined, [])).toBe("");
    expect(pushNote(undefined, [alice])).toBe("pushes go to everyone");
    expect(pushNote("alice@example.com", [alice, bob])).toBe("");
    expect(pushNote("bob@example.com", [alice, bob])).toBe("no ntfy topic: pushes go to everyone");
    expect(pushNote("carol@example.com", [alice])).toBe("no ntfy topic: pushes go to everyone");
    expect(pushNote("carol@example.com", [])).toBe("");
  });
});

describe("assignee names", () => {
  const people: Person[] = [
    { email: "alice@example.com", name: "Alice Smith", has_topic: true },
    { email: "bob@example.com", has_topic: false },
  ];
  it("uses the display name a person set, else the part before the @", () => {
    expect(personName("alice@example.com", people)).toBe("Alice Smith");
    expect(personName("ALICE@example.com", people)).toBe("Alice Smith");
    expect(personName("bob@example.com", people)).toBe("bob");
    expect(personName("carol.jones@example.com", [])).toBe("carol.jones");
  });
  it("initials take the first letters of two words, else the first two letters", () => {
    expect(initials("Alice Smith")).toBe("AS");
    expect(initials("carol.jones")).toBe("CJ");
    expect(initials("bob")).toBe("BO");
    expect(initials("x")).toBe("X");
    expect(initials("  ")).toBe("?");
  });
});
