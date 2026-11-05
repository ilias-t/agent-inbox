// `orch relink`: keep a manager doc's session_url pointing at its live Remote Control session.
// A session's link is https://claude.ai/code/cse_<x>, where <x> is the suffix of the bridgeSessionId
// (session_<x>) in <sessions dir>/<pid>.json. It changes on some resumes, and nothing else updates the doc.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_BASE = "https://claude.ai/code/cse_";
const DONE = new Set(["done", "dropped", "cleaned"]);

// Claude Code's session dirs for each account (personal, team); AGENT_INBOX_SESSION_DIRS overrides (":"-separated).
export function sessionDirs(env, home = homedir()) {
  const o = env.AGENT_INBOX_SESSION_DIRS;
  return o ? o.split(":").filter(Boolean) : [join(home, ".claude", "sessions"), join(home, ".claude-team", "sessions")];
}
// Transcripts live under projects/<cwd-slug>/<sessionId>.jsonl; the team account shares ~/.claude/projects.
export function projectDirs(env, home = homedir()) {
  const o = env.AGENT_INBOX_PROJECT_DIRS;
  return o ? o.split(":").filter(Boolean) : [join(home, ".claude", "projects")];
}

const suffix = (bridge) => (typeof bridge === "string" ? bridge.match(/^(?:session|cse)_([A-Za-z0-9_-]+)$/)?.[1] ?? null : null);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// sessionId → deep link, for the sessions whose process is still running and that have a bridge.
export function liveLinks(dirs) {
  const links = new Map();
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const pid = Number(n.match(/^(\d+)\.json$/)?.[1]);
      if (!pid || !alive(pid)) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, n), "utf8"));
        const x = suffix(d.bridgeSessionId);
        if (x && typeof d.sessionId === "string") links.set(d.sessionId, URL_BASE + x);
      } catch {
        // a pid file being rewritten: the next tick reads it
      }
    }
  }
  return links;
}

// The Claude session id whose transcript records this deep link (any of its past bridge ids), the newest
// transcript when several do; null when none does.
export function sessionForUrl(url, dirs) {
  const x = suffix(url?.replace(/^https:\/\/claude\.ai\/code\//, ""));
  if (!x) return null;
  const needle = `"bridgeSessionId":"cse_${x}"`;
  let best = null;
  for (const dir of dirs) {
    let slugs;
    try {
      slugs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      let files;
      try {
        files = readdirSync(join(dir, slug));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = f.match(/^([0-9a-f-]{36})\.jsonl$/);
        if (!m) continue;
        const p = join(dir, slug, f);
        try {
          if (!readFileSync(p, "latin1").includes(needle)) continue;
          const t = statSync(p).mtimeMs;
          if (!best || t > best.t) best = { id: m[1], t };
        } catch {
          // unreadable: skip
        }
      }
    }
  }
  return best?.id ?? null;
}

// One manager doc → what to do. `live` is liveLinks(); `seed` also looks up a missing session_id in the transcripts.
export function planRelink(doc, live, { seed, projects, nowIso, sessionId }) {
  const d = doc.data ?? {};
  const out = { id: doc.id, patch: null, note: "" };
  let sid = typeof d.session_id === "string" && d.session_id ? d.session_id : "";
  const patch = {};
  if (sessionId && sessionId !== sid) {
    sid = sessionId;
    patch.session_id = sid;
  } else if (!sid && seed) {
    sid = sessionForUrl(d.session_url, projects) ?? "";
    if (sid) patch.session_id = sid;
  }
  if (!sid) {
    out.note = "no session_id (run with --seed, or set it)";
  } else {
    const url = live.get(sid);
    if (!url) {
      out.note = "no live session; link kept";
      if (d.session_live !== false) patch.session_live = false;
    } else if (url === d.session_url) {
      out.note = "unchanged";
      if (d.session_live !== true) patch.session_live = true;
    } else {
      patch.session_live = true;
      patch.session_url = url;
      patch.session_url_at = nowIso;
      out.note = `relinked ${url}` + (d.session_url ? ` (was ${d.session_url})` : "");
    }
  }
  if (Object.keys(patch).length) {
    out.patch = patch;
    if (!out.note.startsWith("relinked")) out.note = (out.note ? out.note + "; " : "") + "seeded session_id " + sid;
  }
  return out;
}

export const isDone = (doc) => DONE.has(doc.data?.status);
