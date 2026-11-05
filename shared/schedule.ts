// Work-hours math shared by the Worker (GET /api/schedule) and the UI header.
// Pure and dependency-free: zone conversions go through Intl, so it runs the
// same in browsers, Node and workerd.

import type { Schedule, ScheduleView } from "./types.ts";

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// Pickups land 3 minutes into each slot, so a cron that fires on the hour
// doesn't race the user's on-the-hour edits.
const PICKUP_OFFSET_MIN = 3;

// Intervals a cron minute (or hour) step can express without drifting across
// the hour: divisors of 60, plus one and two hours.
export const PICKUP_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120];

export interface WorkHours {
  start: number; // minute of day, inclusive
  end: number; // minute of day, exclusive (1440 for "24:00")
  d0: number; // first day, 0 = Sun
  d1: number; // last day; d1 < d0 wraps through the weekend (Fri-Mon)
}

const WORK_HOURS_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+([A-Za-z]{3})(?:-([A-Za-z]{3}))?$/;

function dayIndex(s: string): number {
  return DAYS.findIndex((d) => d.toLowerCase() === s.toLowerCase());
}

// "HH:MM-HH:MM Ddd-Ddd" (or a single "Ddd"). Null when malformed or when the
// window is empty or crosses local midnight (start must be before end).
export function parseWorkHours(s: string): WorkHours | null {
  const m = WORK_HOURS_RE.exec(s.trim());
  if (!m) return null;
  const [h0, m0, h1, m1] = [m[1], m[2], m[3], m[4]].map(Number);
  if (h0 > 23 || m0 > 59 || h1 > 24 || m1 > 59 || (h1 === 24 && m1 !== 0)) return null;
  const start = h0 * 60 + m0;
  const end = h1 * 60 + m1;
  const d0 = dayIndex(m[5]);
  const d1 = m[6] === undefined ? d0 : dayIndex(m[6]);
  if (d0 < 0 || d1 < 0 || start >= end) return null;
  return { start, end, d0, d1 };
}

export function inDays(wh: WorkHours, day: number): boolean {
  return wh.d0 <= wh.d1 ? day >= wh.d0 && day <= wh.d1 : day >= wh.d0 || day <= wh.d1;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function formatWorkHours(wh: WorkHours, sep = "-"): string {
  const days = wh.d0 === wh.d1 ? DAYS[wh.d0] : `${DAYS[wh.d0]}${sep}${DAYS[wh.d1]}`;
  return `${hhmm(wh.start)}${sep}${hhmm(wh.end)} ${days}`;
}

export function validateSchedule(
  input: unknown,
): { ok: true; schedule: Schedule } | { ok: false; message: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "schedule must be an object" };
  }
  const s = input as Record<string, unknown>;
  const wh = typeof s.work_hours === "string" ? parseWorkHours(s.work_hours) : null;
  if (!wh) {
    return { ok: false, message: 'work_hours must be "HH:MM-HH:MM Ddd-Ddd" with start before end' };
  }
  if (typeof s.timezone !== "string" || !s.timezone || !validZone(s.timezone)) {
    return { ok: false, message: "timezone must be an IANA time zone" };
  }
  const intervals = [s.pickup_interval_min, s.sweep_interval_min];
  if (!intervals.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 240)) {
    return { ok: false, message: "pickup_interval_min and sweep_interval_min must be integers 1-240" };
  }
  const [pickup, sweep] = intervals as number[];
  if (!PICKUP_INTERVALS.includes(pickup)) {
    return { ok: false, message: `pickup_interval_min must be one of ${PICKUP_INTERVALS.join(", ")}` };
  }
  if (sweep < pickup) return { ok: false, message: "sweep_interval_min must be >= pickup_interval_min" };
  return {
    ok: true,
    schedule: {
      work_hours: formatWorkHours(wh),
      timezone: s.timezone,
      pickup_interval_min: pickup,
      sweep_interval_min: sweep,
    },
  };
}

// --- Zone math ---------------------------------------------------------------

interface WallClock {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  wd: number; // 0 = Sun
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // hourCycle h23: hour12:false renders midnight as "24" in some engines.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function wallClock(tz: string, t: number): WallClock & { s: number } {
  const parts: Record<string, string> = {};
  for (const p of wallFormatter(tz).formatToParts(new Date(t))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
    wd: dayIndex(parts.weekday),
  };
}

// The zone's offset from UTC in minutes at instant t (-240 for EDT).
export function utcOffsetMin(tz: string, t: number): number {
  const w = wallClock(tz, t);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

// The UTC instant of a wall-clock time in tz. Date.UTC normalizes overflowing
// days/minutes, so callers can pass d + k or minute 1440.
export function zonedToUtc(tz: string, y: number, mo: number, d: number, minuteOfDay: number): number {
  const wall = Date.UTC(y, mo - 1, d, 0, minuteOfDay);
  let t = wall - utcOffsetMin(tz, wall) * 60000;
  // Second pass corrects for a DST change between the guess and the answer.
  t = wall - utcOffsetMin(tz, t) * 60000;
  return t;
}

function zoneLabel(tz: string, t: number): string {
  const name = (style: "short" | "shortGeneric") => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: style })
        .formatToParts(new Date(t))
        .find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return undefined;
    }
  };
  // "ET" / "PT" read better than "EDT"; long generic names ("Japan Time") don't.
  const generic = name("shortGeneric");
  if (generic && !generic.includes(" ") && !generic.startsWith("GMT")) return generic;
  return name("short") ?? tz;
}

// --- Cron --------------------------------------------------------------------

function renderDays(days: number[]): string {
  const set = [...new Set(days.map((d) => ((d % 7) + 7) % 7))].sort((a, b) => a - b);
  if (set.length === 7) return "*";
  const contiguous = set.every((d, i) => i === 0 || d === set[i - 1] + 1);
  if (contiguous && set.length > 1) return `${set[0]}-${set[set.length - 1]}`;
  return set.join(",");
}

function renderHours(h0: number, h1: number, step: number): string {
  const range = h0 === h1 ? String(h0) : `${h0}-${h1}`;
  return step > 1 && h0 !== h1 ? `${range}/${step}` : range;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const hourStep = (interval: number) => (interval >= 60 ? Math.max(1, Math.round(interval / 60)) : 1);

// The pickup grid in UTC at the zone's offset `offset`. The cron covers every
// UTC hour the window touches, so it is a superset when the window (or the
// zone's offset) isn't on whole hours; the manager skips firings outside
// hours. `exact` says whether every firing falls inside the window.
function pickupGrid(wh: WorkHours, interval: number, offset: number) {
  const days: number[] = [];
  for (let d = 0; d < 7; d++) if (inDays(wh, d)) days.push(d);
  const s = wh.start - offset;
  const shift = Math.floor(s / 1440);
  const sHour = Math.floor((s - shift * 1440) / 60);
  const eHourExcl = Math.ceil((wh.end - offset - shift * 1440) / 60);
  const step = hourStep(interval);
  const minute = interval >= 60 ? String(PICKUP_OFFSET_MIN) : `${PICKUP_OFFSET_MIN}-59/${interval}`;
  const expr = (h0: number, h1: number, dayShift: number) =>
    `${minute} ${renderHours(h0, h1, step)} * * ${renderDays(days.map((d) => d + dayShift))}`;

  let cron: string[];
  if (eHourExcl <= 24) {
    cron = [expr(sHour, eHourExcl - 1, shift)];
  } else {
    // Split at UTC midnight, keeping the hour step's phase.
    const firstNext = step > 1 ? (step - ((24 - sHour) % step)) % step : 0;
    cron = [expr(sHour, 23, shift)];
    if (firstNext <= eHourExcl - 25) cron.push(expr(firstNext, eHourExcl - 25, shift + 1));
  }

  // Whether a UTC instant (on a whole minute) is a cron firing. The hour check
  // matters when the window's offset differs from the cron's (the day DST
  // starts or ends): the window then opens or closes outside the cron's hours.
  const fires = (t: number): boolean => {
    const d = new Date(t);
    const m = d.getUTCMinutes();
    const h = mod(d.getUTCHours() - sHour, 24);
    if (h >= eHourExcl - sHour) return false;
    if (interval >= 60) return m === PICKUP_OFFSET_MIN && h % step === 0;
    return m >= PICKUP_OFFSET_MIN && (m - PICKUP_OFFSET_MIN) % interval === 0;
  };
  const exact = mod(wh.start - offset, 60) === 0 && mod(wh.end - offset, 60) === 0;
  return { cron, fires, exact };
}

// --- Computed view -----------------------------------------------------------

export function computeSchedule(schedule: Schedule, now: Date): ScheduleView["computed"] {
  const t = now.getTime();
  const tz = schedule.timezone;
  const interval = schedule.pickup_interval_min;
  const wh = parseWorkHours(schedule.work_hours)!;
  const offset = utcOffsetMin(tz, t);
  const w = wallClock(tz, t);
  const grid = pickupGrid(wh, interval, offset);

  // Window [start, end) for the local day k days from today, if it is a work day.
  const windowAt = (k: number): [number, number] | null => {
    if (!inDays(wh, (w.wd + k) % 7)) return null;
    return [zonedToUtc(tz, w.y, w.mo, w.d + k, wh.start), zonedToUtc(tz, w.y, w.mo, w.d + k, wh.end)];
  };

  // First cron firing in [from, to). Inside the cron's hours firings are at
  // most max(interval, 6) minutes apart ("3-59/3" skips :00-:02), so the scan
  // is short; across a DST change it may first walk the hour the cron skips.
  const firstFiring = (from: number, to: number): number | null => {
    for (let x = Math.ceil(from / 60000) * 60000; x < to; x += 60000) if (grid.fires(x)) return x;
    return null;
  };

  const today = windowAt(0);
  const inHours = today !== null && t >= today[0] && t < today[1];
  let nextWindow: number | null = null;
  let nextPickup: number | null = null;
  for (let k = 0; k <= 8; k++) {
    const win = windowAt(k);
    if (!win || win[1] <= t) continue;
    if (nextWindow === null && win[0] > t) nextWindow = win[0];
    nextPickup ??= firstFiring(Math.max(t, win[0]), win[1]);
    if (nextWindow !== null && nextPickup !== null) break;
  }

  const zone = zoneLabel(tz, t);
  const days = wh.d0 === wh.d1 ? DAYS[wh.d0] : `${DAYS[wh.d0]}–${DAYS[wh.d1]}`;
  return {
    now: now.toISOString(),
    in_hours: inHours,
    next_pickup_at: nextPickup === null ? null : new Date(nextPickup).toISOString(),
    next_window_start: nextWindow === null ? null : new Date(nextWindow).toISOString(),
    label: `${hhmm(wh.start)}–${hhmm(wh.end)} ${zone}, ${days}`,
    utc_offset_min: offset,
    cron_utc: grid.cron,
    cron_exact: grid.exact,
  };
}
