// Flag value parsers. They throw UsageError, which main() turns into exit 2.

export class UsageError extends Error {}

const CONFIDENCE = new Set(["high", "medium", "low"]);

// `key=value` sets a string; `key:=<json>` sets a typed value
// (`qa_pending:=false`, `pr:={"number":12}`, `asks:=null` deletes on PATCH).
export function parseSets(list = []) {
  const out = {};
  for (const arg of list) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new UsageError(`--set expects key=value or key:=json, got "${arg}"`);
    if (arg[eq - 1] === ":") {
      const key = arg.slice(0, eq - 1);
      if (!key) throw new UsageError(`--set: missing key in "${arg}"`);
      try {
        out[key] = JSON.parse(arg.slice(eq + 1));
      } catch {
        throw new UsageError(`--set ${key}:= expects JSON, got ${arg.slice(eq + 1)}`);
      }
    } else {
      out[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

// Splits on the first `limit - 1` separators; the last part keeps the rest.
function splitN(s, sep, limit) {
  const parts = [];
  let rest = s;
  while (parts.length < limit - 1) {
    const i = rest.indexOf(sep);
    if (i === -1) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  parts.push(rest);
  return parts;
}

// `id:label[:description]` → Option. The description may contain colons.
export function parseOption(arg) {
  const [id, label, description] = splitN(arg, ":", 3);
  if (!id) throw new UsageError(`--option expects id:label[:description], got "${arg}"`);
  const option = { id, label: label || id };
  if (description) option.description = description;
  return option;
}

// `option[:confidence[:why]]` → Recommendation.
export function parseRecommend(arg) {
  const [option, confidence, why] = splitN(arg, ":", 3);
  if (!option) throw new UsageError(`--recommend expects option[:confidence[:why]], got "${arg}"`);
  const rec = { option };
  if (confidence) {
    if (!CONFIDENCE.has(confidence)) throw new UsageError(`--recommend confidence must be high, medium or low`);
    rec.confidence = confidence;
  }
  if (why) rec.why = why;
  return rec;
}

// `label=url` → Link (a bare url is its own label).
export function parseLink(arg, flag = "--link") {
  const eq = arg.indexOf("=");
  const looksLikeUrl = /^https?:\/\//.test(arg);
  if (eq === -1 || (looksLikeUrl && arg.indexOf("://") < eq)) {
    if (!looksLikeUrl) throw new UsageError(`${flag} expects label=url, got "${arg}"`);
    return { label: arg, url: arg };
  }
  return { label: arg.slice(0, eq), url: arg.slice(eq + 1) };
}

// `choice[:note]` → Decision for auto_decided items.
export function parseDecision(arg, now) {
  const [choice, note] = splitN(arg, ":", 2);
  if (!choice) throw new UsageError(`--decision expects choice[:note], got "${arg}"`);
  const decision = { choice, decided_at: now };
  if (note) decision.note = note;
  return decision;
}

export function parseIntFlag(value, flag, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new UsageError(`${flag} expects an integer, got "${value}"`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}`);
  return n;
}

// `--next-tick` accepts an ISO timestamp or `+<N>m` / `+<N>h` from now.
export function parseWhen(value, nowMs) {
  if (value === undefined) return undefined;
  const rel = /^\+(\d+)([mh])$/.exec(value);
  if (rel) return new Date(nowMs + Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 60_000)).toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new UsageError(`expected an ISO timestamp or +<N>m, got "${value}"`);
  return new Date(t).toISOString();
}

export function commaList(value) {
  if (value === undefined) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}
