// Items fetched by id (an older archived item's own page, History's pinned items beyond the loaded window): a fetch
// that failed (offline, a server error) is tried again after the next successful sync; one the server said is gone
// (404) is not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal, ScheduleView, StateResponse } from "../../shared/types.ts";

type StateMod = typeof import("../../src/state.ts");
const me: Principal = { kind: "human", email: "you@test", role: "admin", is_admin: true };
const snapshot = (cursor: number): StateResponse => ({
  items: [], orchestrators: [], manager: null, lease: null, schedule: { schedule: { timezone: "UTC" }, computed: {} } as unknown as ScheduleView,
  cursor, me, people: [], snoozes: {}, pins: {}, archived_total: 0, archived_more: false,
});

let S: StateMod;
beforeEach(async () => {
  vi.resetModules();
  S = await import("../../src/state.ts");
});

describe("state.itemFetch across syncs", () => {
  it("a successful sync forgets failed fetches, so they're tried again, and keeps the ones known gone or in flight", () => {
    S.applySync({ full: true, state: snapshot(1) });
    S.state.itemFetch.set("offline", "failed");
    S.state.itemFetch.set("gone", "missing");
    S.state.itemFetch.set("busy", "loading");
    S.applySync({ full: false, state: snapshot(2), deleted: [], qa: [] });
    expect(S.state.itemFetch.has("offline")).toBe(false);
    expect(S.state.itemFetch.get("gone")).toBe("missing");
    expect(S.state.itemFetch.get("busy")).toBe("loading");
  });
});
