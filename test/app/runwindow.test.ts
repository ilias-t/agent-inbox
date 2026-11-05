import { describe, expect, it } from "vitest";
import type { ReviewRun, RoutineReviewsResponse } from "../../shared/types.ts";
import { RunWindow, RunWindows } from "../../src/lib/runwindow.ts";
import { stampOf, uiRoutine, uiRuns } from "../fixtures/review-ui.ts";

const NOW = Date.parse("2026-10-08T19:30:00Z"), HOUR = 3600000;
const tick = () => new Promise((r) => setTimeout(r, 0));
const run = (i: number): ReviewRun => ({ ...uiRuns(NOW)[0], stamp: stampOf(NOW - i * HOUR) });

// GET /api/reviews/:routine as a server whose runs can grow, answering only when the test says so: each call waits
// in `calls` until it's resolved (from the runs as they are then) or rejected.
function server(count: number) {
  let runs = Array.from({ length: count }, (_, i) => run(i + 1)), version = 1;
  const calls: { before?: string; limit: number; settle: (ok: boolean) => void }[] = [];
  const page = (before: string | undefined, limit: number): RoutineReviewsResponse => {
    const older = before ? runs.filter((r) => r.stamp < before) : runs;
    return { ...uiRoutine(NOW), routine: { ...uiRoutine(NOW).routine, version }, runs: older.slice(0, limit), more: older.length > limit };
  };
  const fetch = (before?: string, limit = 30) => new Promise<RoutineReviewsResponse>((resolve, reject) => {
    calls.push({ before, limit, settle: (ok) => (ok ? resolve(page(before, limit)) : reject(new Error("500"))) });
  });
  return {
    calls, fetch,
    addRun: () => { runs = [run(0), ...runs]; version++; },
    all: () => runs.map((r) => r.stamp),
    // Settles the next waiting call (once the queue has made it), then lets the queue move on to its next step.
    next: async (ok = true) => { await tick(); const c = calls.shift(); if (!c) throw new Error("no call waiting"); c.settle(ok); await tick(); },
  };
}
const shown = (w: RunWindow) => w.runs().map((r) => r.stamp);

// Loads the newest page and then older pages until the window holds 60 runs.
async function sixty(s: ReturnType<typeof server>, w: RunWindow): Promise<void> {
  const r = w.refresh(); await s.next(); await r;
  const o = w.loadOlder(); await s.next(); await o;
}

describe("RunWindow", () => {
  it("loads the newest page, then older pages before its last run", async () => {
    const s = server(60), w = new RunWindow(s.fetch);
    await sixty(s, w);
    expect(shown(w)).toEqual(s.all());
    expect(w.more()).toBe(false);
  });

  it("a refresh refills what the new page pushed out of the older pages: one continuous window", async () => {
    const s = server(60), w = new RunWindow(s.fetch);
    await sixty(s, w);
    s.addRun();
    const r = w.refresh(); await s.next(); await s.next(); await r;
    expect(shown(w)).toEqual(s.all());
  });

  it("a refresh whose refill fails changes nothing and rejects; trying again loads it", async () => {
    const s = server(60), w = new RunWindow(s.fetch);
    await sixty(s, w);
    const before = shown(w);
    s.addRun();
    const r = w.refresh(); await s.next(); await s.next(false);
    await expect(r).rejects.toThrow("500");
    expect(shown(w)).toEqual(before); // neither the new page nor a half-refilled window
    const again = w.refresh(); await s.next(); await s.next(); await again;
    expect(shown(w)).toEqual(s.all());
  });

  it("Load older then a refresh: they run one after the other, and the window keeps every run", async () => {
    const s = server(90), w = new RunWindow(s.fetch);
    const first = w.refresh(); await s.next(); await first; // 30
    const older = w.loadOlder(); s.addRun(); const r = w.refresh();
    await tick();
    expect(s.calls).toHaveLength(1); // the refresh waits for Load older
    await s.next(); await older; // 60
    await s.next(); await s.next(); await r; // the new page, then the refill down to the oldest loaded
    expect(shown(w)).toEqual(s.all().slice(0, 61));
    expect(w.more()).toBe(true);
  });

  it("a refresh then Load older: Load older pages on from the refreshed window", async () => {
    const s = server(90), w = new RunWindow(s.fetch);
    await sixty(s, w);
    s.addRun();
    const r = w.refresh(), older = w.loadOlder();
    await s.next(); await s.next(); await r; // refresh and refill first
    await s.next(); await older;
    expect(shown(w)).toEqual(s.all());
    expect(w.more()).toBe(false);
  });
});

describe("RunWindows", () => {
  it("a window replaced while its request was out never commits over the new one's data", async () => {
    // Routine a: loaded, then Load older starts; the viewer switches away and back, so a's window is replaced, and the
    // new one's refresh (a newer version) lands before the old Load older's page does.
    const s = server(60), commits: { routine: string; version: number | undefined }[] = [];
    const ws = new RunWindows(() => s.fetch, (routine, win) => commits.push({ routine, version: win.data?.routine.version }));
    const first = ws.get("a").refresh(); await s.next(); await first;
    const stale = ws.get("a").loadOlder(); await tick();
    ws.reset("a");
    s.addRun(); // version 2
    const fresh = ws.get("a").refresh(); await tick();
    const [oldPage, ...rest] = s.calls.splice(0); s.calls.push(...rest); // the fresh refresh answers first
    await s.next(); await fresh;
    oldPage.settle(true); await stale;
    expect(commits.map((c) => c.version)).toEqual([1, 2]);
  });
});
