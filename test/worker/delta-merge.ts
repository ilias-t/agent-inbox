// Applies GET /api/state/delta responses to a /api/state snapshot with the client's own merge (src/lib/delta.ts),
// so the random run in delta.test.ts checks what the page ships, and normalizes snapshots so a merged one can be
// compared with a fresh one.
import type { StateDeltaResponse, StateResponse } from "../../shared/types.ts";
import { mergeDelta } from "../../src/lib/delta.ts";

export function applyDelta(s: StateResponse, d: StateDeltaResponse): StateResponse {
  return mergeDelta(s, d);
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// What must match between a merged snapshot and a fresh one: everything but the schedule's `computed` (it is
// computed at read time; the client recomputes it) and `archived_more` (a delta never carries it).
const withoutComputed = ({ computed: _computed, ...rest }: StateResponse["schedule"]) => rest;

export function normalize(s: StateResponse) {
  const schedule = withoutComputed(s.schedule);
  return {
    items: [...s.items].sort(byId),
    orchestrators: [...s.orchestrators].sort(byId),
    manager: s.manager,
    lease: s.lease,
    schedule,
    cursor: s.cursor,
    me: s.me,
    people: s.people,
    snoozes: s.snoozes,
    pins: s.pins,
    archived_total: s.archived_total,
    routines: s.routines,
    fleets: s.fleets && Object.fromEntries(Object.entries(s.fleets).map(([id, f]) => [id, { ...f, schedule: withoutComputed(f.schedule) }])),
  };
}

// A small seeded PRNG (mulberry32), so a failing sequence replays exactly.
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
  };
}
