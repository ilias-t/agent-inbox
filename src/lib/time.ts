import { esc } from "./dom.ts";

export function toMs(t: unknown): number {
  if (t == null || t === "") return NaN;
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  return Date.parse(String(t));
}

// "3m ago" / "in 3m" / "just now"; compact drops "ago" ("3m", "now").
export function relTime(t: unknown, compact = false, now = Date.now()): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  const d = now - ms, a = Math.abs(d), future = d < 0;
  const m = Math.round(a / 60000);
  let s: string;
  if (a < 45000) return compact ? "now" : (future ? "now" : "just now");
  if (m < 60) s = m + "m";
  else if (m < 60 * 24) s = Math.round(m / 60) + "h";
  else s = Math.round(m / 1440) + "d";
  if (compact) return future ? "in " + s : s;
  return future ? "in " + s : s + " ago";
}

// One formatter each, made on first use: toLocaleString() with options builds a new one per call, which made
// formatting a 2,000-row History's titles ~50x slower (most of a re-render).
let absFmt: Intl.DateTimeFormat | null = null, clockFmt: Intl.DateTimeFormat | null = null;

export function absTime(t: unknown): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  absFmt ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return absFmt.format(ms);
}

export function clockTime(t: unknown): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  clockFmt ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return clockFmt.format(ms);
}

// A relative time the minute timer keeps fresh (it rewrites every .rel[data-ts]).
export function relSpan(t: unknown, compact = false, now = Date.now()): string {
  if (isNaN(toMs(t))) return "";
  return '<span class="rel" data-ts="' + esc(t) + '"' + (compact ? ' data-compact="1"' : "") + ' title="' + esc(absTime(t)) + '">' + esc(relTime(t, compact, now)) + "</span>";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One formatter per zone, made on first use (History asks for thousands of rows' days per render).
const zoneFmts = new Map<string, Intl.DateTimeFormat>();
// Wall-clock parts of an instant in an IANA zone; "EDT"/"EST" read as "ET" like the schedule label. Throws for an
// unknown zone.
export function zoneParts(ms: number, tz: string): { day: number; hhmm: string; zone: string; ymd: string } {
  const p: Record<string, string> = {};
  let f = zoneFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
    zoneFmts.set(tz, f);
  }
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return {
    day: DAYS.indexOf(p.weekday),
    hhmm: String(+p.hour % 24).padStart(2, "0") + ":" + p.minute,
    zone: String(p.timeZoneName || "").replace(/^([ECMP])[DS]T$/, "$1T"),
    ymd: p.year + "-" + p.month + "-" + p.day,
  };
}

// "14:23" when the slot is today in the zone (or "<todayWord> 14:23"), otherwise "Thu 10:03"; withZone appends " ET".
export function slotTime(t: unknown, tz: string, now = Date.now(), withZone = false, todayWord = ""): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  let at, today;
  try { at = zoneParts(ms, tz); today = zoneParts(now, tz); } catch { return clockTime(t); }
  const day = at.ymd === today.ymd ? (todayWord ? todayWord + " " : "") : (DAYS[at.day] || "") + " ";
  return day + at.hhmm + (withZone && at.zone ? " " + at.zone : "");
}

// The time of day in the zone, "09:12" (the browser's own clock time for a zone it doesn't know).
export function zoneClock(t: unknown, tz: string): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  try { return zoneParts(ms, tz).hhmm; } catch { return clockTime(t); }
}

// The full time in the zone, named: "Mon 5 Oct 2026, 09:12 ET" (a row's tooltip beside its zoneClock time).
export function zoneStamp(t: unknown, tz: string): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  let p;
  try { p = zoneParts(ms, tz); } catch { return absTime(t); }
  const [y, mo, d] = p.ymd.split("-").map(Number);
  return DAYS[p.day] + " " + d + " " + MONTHS[mo - 1] + " " + y + ", " + p.hhmm + (p.zone ? " " + p.zone : "");
}

/* ---------- days: History's group headers ---------- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The calendar day an instant falls on in the zone, "2026-10-05" ("" for what isn't a time). A zone it doesn't know
// counts in UTC.
export function dayKey(t: unknown, tz: string): string {
  const ms = toMs(t); if (isNaN(ms)) return "";
  try { return zoneParts(ms, tz).ymd; } catch { return new Date(ms).toISOString().slice(0, 10); }
}
// "Today", "Yesterday" or "Mon 5 Oct" (with the year when it isn't this one) for a dayKey, as seen from `now` in the
// zone; "Earlier" for an undated row.
export function dayLabel(key: string, tz: string, now = Date.now()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return "Earlier";
  const today = dayKey(now, tz);
  if (key === today) return "Today";
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const at = Date.UTC(y, mo - 1, d), t = today.split("-").map(Number);
  if (Date.UTC(t[0], t[1] - 1, t[2]) - at === 86400000) return "Yesterday";
  return DAYS[new Date(at).getUTCDay()] + " " + d + " " + MONTHS[mo - 1] + (y === t[0] ? "" : " " + y);
}
