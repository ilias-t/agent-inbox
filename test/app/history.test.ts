import { describe, expect, it } from "vitest";
import { HISTORY_FILTERS, appendedRows, dayRuns, filterHistory, historyTotal, isHistoryFilter, serverMatches, wantsServerSearch } from "../../src/lib/history.ts";
import type { ItemRow } from "../../src/lib/items.ts";

const at = "2026-10-01T00:00:00Z";
const item = (over: Partial<ItemRow> & { id: string }): ItemRow => ({ type: "decision", title: over.id, status: "decided", ...over }) as ItemRow;

const items = [
  item({ id: "db", title: "Postgres or SQLite?", orchestrator: "O3", decision: { choice: "pg", note: "Go with managed Postgres", decided_at: at, by: "human:you@test" } }),
  item({ id: "ci", title: "Flaky CI", summary: "The **e2e** suite times out", decision: { choice: "ack", decided_at: at, by: "human:alice@test" } }),
  item({ id: "q", title: "Rename", question: "Rename the Billing module?", decision: { choice: "approve", decided_at: at, by: "hook:ntfy" } }),
  item({ id: "auto1", type: "auto_decided", status: "archived", title: "Bumped deps", decision: { choice: "bump", decided_at: at, by: "token:orch-O7" } }),
  item({ id: "auto2", type: "auto_decided", title: "Skipped flaky test", decision: { choice: "override", note: "Fix it instead", decided_at: at, by: "human:You@Test" }, override_of: "skip" }),
];
const ids = (xs: ItemRow[]) => xs.map((i) => i.id);

describe("filterHistory: search", () => {
  it("matches the title, case-insensitively", () => {
    expect(ids(filterHistory(items, "postgres", "all", null))).toEqual(["db"]);
  });
  it("matches the summary, the question, the decision note and the orchestrator id", () => {
    expect(ids(filterHistory(items, "E2E", "all", null))).toEqual(["ci"]);
    expect(ids(filterHistory(items, "billing", "all", null))).toEqual(["q"]);
    expect(ids(filterHistory(items, "managed", "all", null))).toEqual(["db"]);
    expect(ids(filterHistory(items, "o3", "all", null))).toEqual(["db"]);
  });
  it("needs every word to match somewhere, in any order", () => {
    expect(ids(filterHistory(items, "sqlite o3", "all", null))).toEqual(["db"]);
    expect(ids(filterHistory(items, "sqlite flaky", "all", null))).toEqual([]);
  });
  it("a blank query keeps everything, in order", () => {
    expect(ids(filterHistory(items, "   ", "all", null))).toEqual(ids(items));
  });
});

describe("filterHistory: quick filters", () => {
  it("Decided by me: decisions whose by is the signed-in human, any case", () => {
    expect(ids(filterHistory(items, "", "mine", "you@test"))).toEqual(["db", "auto2"]);
  });
  it("Decided by me is empty without a signed-in human", () => {
    expect(filterHistory(items, "", "mine", null)).toEqual([]);
  });
  it("Auto-decided: every auto_decided item, accepted or overridden", () => {
    expect(ids(filterHistory(items, "", "auto", null))).toEqual(["auto1", "auto2"]);
  });
  it("Overridden: decisions that override the agent's call", () => {
    expect(ids(filterHistory(items, "", "overridden", null))).toEqual(["auto2"]);
  });
  it("combines with the search", () => {
    expect(ids(filterHistory(items, "flaky", "auto", null))).toEqual(["auto2"]);
  });
});

describe("wantsServerSearch: when History also asks the server", () => {
  it("asks once the query has 2+ characters and older archived items aren't loaded", () => {
    expect(wantsServerSearch("pg", true)).toBe(true);
    expect(wantsServerSearch("  postgres  ", true)).toBe(true);
  });
  it("doesn't for a 1-character or blank query", () => {
    expect(wantsServerSearch("p", true)).toBe(false);
    expect(wantsServerSearch(" p ", true)).toBe(false);
    expect(wantsServerSearch("", true)).toBe(false);
  });
  it("doesn't once every archived item is loaded: the local search sees them all", () => {
    expect(wantsServerSearch("postgres", false)).toBe(false);
  });
});

describe("serverMatches: the server's hits beside the local ones", () => {
  const hit = (id: string, over: Partial<ItemRow> = {}) => item({ id, status: "archived", title: "Postgres " + id, ...over });
  it("leaves out items already loaded locally, keeping the server's order", () => {
    const hits = [hit("old2"), hit("db"), hit("old1")];
    expect(ids(serverMatches(hits, new Set(ids(items)), "postgres", "all", null))).toEqual(["old2", "old1"]);
  });
  it("applies the quick filter, as the local list does", () => {
    const hits = [hit("mine", { decision: { choice: "a", decided_at: at, by: "human:you@test" } }), hit("theirs")];
    expect(ids(serverMatches(hits, new Set(), "postgres", "mine", "you@test"))).toEqual(["mine"]);
  });
  it("drops duplicates within the hits", () => {
    expect(ids(serverMatches([hit("a"), hit("a")], new Set(), "postgres", "all", null))).toEqual(["a"]);
  });
});

describe("isHistoryFilter", () => {
  it("accepts the four filters only", () => {
    expect(HISTORY_FILTERS).toEqual(["all", "mine", "auto", "overridden"]);
    expect(isHistoryFilter("mine")).toBe(true);
    expect(isHistoryFilter("nope")).toBe(false);
  });
});

describe("historyTotal", () => {
  it("counts decided, processing and archived items, not open ones", () => {
    const xs = [item({ id: "d" }), item({ id: "p", status: "processing" }), item({ id: "a", status: "archived" }), item({ id: "o", status: "open" })];
    expect(historyTotal(xs, 0)).toBe(3);
  });
  it("counts archived items not loaded yet from the server's archived total", () => {
    const xs = [item({ id: "d" }), item({ id: "a1", status: "archived" }), item({ id: "a2", status: "archived" })];
    expect(historyTotal(xs, 10)).toBe(11);
  });
  it("never counts fewer archived items than are loaded", () => {
    const xs = [item({ id: "a1", status: "archived" }), item({ id: "a2", status: "archived" })];
    expect(historyTotal(xs, 1)).toBe(2);
  });
});

describe("appendedRows: Load older appends when the shown list only grew at the end", () => {
  const rows = (...xs: string[]) => xs.map((id) => item({ id }));
  it("returns the rows after the ones already shown", () => {
    expect(ids(appendedRows(["a", "b"], rows("a", "b", "c", "d"))!)).toEqual(["c", "d"]);
  });
  it("returns nothing new when the page added no shown rows (a filter hides them all)", () => {
    expect(appendedRows(["a", "b"], rows("a", "b"))).toEqual([]);
  });
  it("is null when a new row sorts in among the shown ones (decided later than it was archived)", () => {
    expect(appendedRows(["a", "b"], rows("a", "c", "b"))).toBeNull();
  });
  it("is null when a shown row is gone", () => {
    expect(appendedRows(["a", "b"], rows("a", "c"))).toBeNull();
  });
});

describe("dayRuns: History's rows under day headers", () => {
  const row = (id: string, day: string) => ({ id, day });
  const dayOf = (r: { day: string }) => r.day;
  const shape = (runs: ReturnType<typeof dayRuns<{ id: string; day: string }>>) => runs.map((r) => [r.day, r.head, r.rows.map((x) => x.id)]);
  it("one run per day, in order, each with a header", () => {
    const rows = [row("a", "10-07"), row("b", "10-07"), row("c", "10-06"), row("d", "10-05")];
    expect(shape(dayRuns(rows, dayOf))).toEqual([["10-07", true, ["a", "b"]], ["10-06", true, ["c"]], ["10-05", true, ["d"]]]);
  });
  it("nothing for no rows", () => {
    expect(dayRuns([], dayOf)).toEqual([]);
  });
  it("appending (Load older): rows that continue the last shown day get no second header", () => {
    expect(shape(dayRuns([row("e", "10-05"), row("f", "10-04")], dayOf, "10-05"))).toEqual([["10-05", false, ["e"]], ["10-04", true, ["f"]]]);
  });
  it("appending: a page that starts a new day heads it", () => {
    expect(shape(dayRuns([row("f", "10-04")], dayOf, "10-05"))).toEqual([["10-04", true, ["f"]]]);
  });
  it("shown, then appended, reads the same as all of it at once", () => {
    const all = [row("a", "10-07"), row("b", "10-06"), row("c", "10-06"), row("d", "10-05")];
    const heads = (runs: ReturnType<typeof dayRuns<{ id: string; day: string }>>) => runs.filter((r) => r.head).map((r) => r.day);
    const first = dayRuns(all.slice(0, 2), dayOf), rest = dayRuns(all.slice(2), dayOf, first[first.length - 1].day);
    expect([...heads(first), ...heads(rest)]).toEqual(heads(dayRuns(all, dayOf)));
  });
});
