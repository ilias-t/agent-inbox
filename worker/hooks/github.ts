// POST /hooks/github: PR state onto linked items and orchestrators, and GitHub facts onto review routines' PRs.

import type { Item, Link, Orchestrator, ReviewPrGh } from "../../shared/types.ts";
import type { Env } from "../env.ts";
import { badRequest, hmacHex, HttpError, isObject, json, readBytes, safeEqual, unauthorized } from "../http.ts";
import { headBump } from "../reviews.ts";
import { mutate } from "../store.ts";

const ACTOR = "hook:github";

// Every item field the item loop below reads to decide whether a delivery closes the item, and what it
// stamps: which items it matches (links, evidence), whether it may close one (status, type, close_on_pr),
// what pr_state becomes, and the decision it writes. checkScopedWrite (routes/items.ts) refuses any change
// to these from an orchestrator token that didn't ask the question, so it can't steer a closure of someone
// else's question. Make the loop read another field and it belongs here too.
export const CLOSURE_FIELDS = ["close_on_pr", "links", "evidence", "type", "status", "pr_state", "decision"] as const;
const REVIEW_STATES = new Set(["approved", "changes_requested", "commented"]);

// The PR page itself or one of its sub-pages (/files, /commits, ...).
const linksTo = (url: string, pr: string) => url === pr || url.startsWith(`${pr}/`) || url.startsWith(`${pr}#`);

// merged and closed are terminal, so a late review or a replayed delivery can't move the
// state back. closed may still become merged: GitHub can only merge a closed PR after a
// reopen, which we don't track, so the merge itself says the reopen happened.
const advances = (cur: string | undefined, next: string) =>
  cur !== "merged" && (cur !== "closed" || next === "merged");

// links and evidence that aren't arrays (only an import could store them) carry nothing.
const list = (v: unknown): Link[] => (Array.isArray(v) ? v : []);

function itemLinksTo(item: Item, pr: string): boolean {
  return [...list(item.links), ...list(item.evidence)].some((l) => typeof l?.url === "string" && linksTo(l.url, pr));
}

const orchestratorLinksTo = (o: Orchestrator, pr: string) =>
  typeof o.pr?.url === "string" && o.pr.url.replace(/\/+$/, "") === pr;

// The ids of the docs that link to `pr`, oldest first, from doc_links (migration
// 0008): an index search, however long History grows. Items keep their urls
// verbatim, so linksTo is an equality plus the ranges [pr/, pr0) and [pr#, pr$)
// ('0' and '$' are the bytes after '/' and '#'); orchestrators keep pr.url with
// trailing slashes trimmed, so theirs is an equality. Exactly the docs
// itemLinksTo / orchestratorLinksTo accept; the write re-checks anyway.
export function linkedQuery(collection: "items" | "orchestrators", pr: string): { sql: string; binds: unknown[] } {
  // One SELECT per term: for an OR of them SQLite reads the collection's whole index.
  const terms: [string, unknown[]][] =
    collection === "items"
      ? [["url = ?", [pr]], ["url >= ? AND url < ?", [`${pr}/`, `${pr}0`]], ["url >= ? AND url < ?", [`${pr}#`, `${pr}$`]]]
      : [["url = ?", [pr]]];
  const links = terms.map(([t]) => `SELECT id FROM doc_links WHERE collection = ? AND ${t}`).join(" UNION ALL ");
  return {
    sql: `SELECT id FROM docs WHERE collection = ? AND id IN (${links}) ORDER BY created_at, id`,
    binds: [collection, ...terms.flatMap(([, b]) => [collection, ...b])],
  };
}

export async function linkedIds(db: D1Database, collection: "items" | "orchestrators", pr: string): Promise<string[]> {
  const { sql, binds } = linkedQuery(collection, pr);
  const { results } = await db.prepare(sql).bind(...binds).all<{ id: string }>();
  return results.map((r) => r.id);
}

// What a delivery says about its PR, for review_prs.gh (docs/reviews.md "GitHub hook").
type GhFact =
  | { kind: "push"; head_sha: string; pushed_at: string; delivery: string } // synchronize
  | { kind: "review"; review: { login: string; state: string; at: string } } // pull_request_review submitted
  // State deliveries carry `at` (pull_request.updated_at, which orders them) and `delivery` (X-GitHub-Delivery,
  // which a redelivery repeats).
  | { kind: "end"; state: "merged" | "closed"; at: string; delivery: string } // closed
  | { kind: "state"; state: "open" | "draft"; reopen: boolean; at: string; delivery: string }; // reopened, converted_to_draft, ready_for_review

// The PR url; its new state for items and orchestrators, null when the event doesn't move it; and its fact for
// review_prs, null when it has none. Null for events we don't handle.
interface PrEvent {
  url: string;
  state: string | null;
  fact: GhFact | null;
}

// A payload time, normalized like every time the Worker writes; `now` when it's missing or not a time.
const timeOr = (v: unknown, now: string) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? now : new Date(t).toISOString();
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

function prEvent(event: string | null, delivery: string, payload: Record<string, unknown>, now: string): PrEvent | null {
  const pr = payload.pull_request;
  if (!isObject(pr)) return null;
  let state: string | null = null;
  let fact: GhFact | null = null;
  if (event === "pull_request") {
    const at = timeOr(pr.updated_at, now);
    switch (payload.action) {
      case "closed":
        state = pr.merged ? "merged" : "closed";
        fact = { kind: "end", state: pr.merged ? "merged" : "closed", at, delivery };
        break;
      case "synchronize":
        fact = { kind: "push", head_sha: str(isObject(pr.head) ? pr.head.sha : null) || str(payload.after), pushed_at: at, delivery };
        break;
      case "reopened":
        fact = { kind: "state", state: pr.draft === true ? "draft" : "open", reopen: true, at, delivery };
        break;
      case "converted_to_draft":
        fact = { kind: "state", state: "draft", reopen: false, at, delivery };
        break;
      case "ready_for_review":
        fact = { kind: "state", state: "open", reopen: false, at, delivery };
        break;
    }
  }
  if (event === "pull_request_review" && payload.action === "submitted" && isObject(payload.review)) {
    const r = payload.review;
    const s = String(r.state ?? "").toLowerCase();
    if (REVIEW_STATES.has(s)) {
      state = s;
      const login = str(isObject(r.user) ? r.user.login : null);
      if (login) fact = { kind: "review", review: { login, state: s, at: timeOr(r.submitted_at, now) } };
    }
  }
  if (!state && !fact) return null;
  if (typeof pr.html_url !== "string" || !pr.html_url) throw badRequest("pull_request.html_url missing");
  return { url: pr.html_url.replace(/\/+$/, ""), state, fact };
}

// --- review_prs ----------------------------------------------------------------------------------------------

const REVIEWS_KEPT = 30;
const DELIVERIES_KEPT = 20;

// A row's gh and gone_at after `fact`, or null when the fact changes nothing. advances()'s terminal rule: merged
// takes nothing more, and closed takes only a merge or a reopen, which un-gones the row. Deliveries can arrive
// late, twice or out of order, so:
// - a state delivery older than the newest one applied (state_at), or one already applied (its delivery id in
//   state_deliveries), changes nothing; a merge always lands, since nothing comes after it. A newer one that
//   leaves the state as it is (a second close) still moves state_at, so an older one delivered after it stays out.
//   One watermark covers every state: a draft or ready delivery newer than a close revives the PR, since its
//   reopen must have come in between (close t1, reopen t2, draft t3, delivered t1, t3, t2 ends as a draft);
// - a push already applied (its delivery id in push_deliveries), older than the recorded one, or at the same
//   second with a head sha already pushed in that second (push_shas) changes nothing. GitHub's times are in
//   seconds, so two pushes can share one: the later delivery of a new sha takes the head, and a late one of an
//   earlier sha from that second, whatever its delivery id, doesn't take it back;
// - a review already recorded changes nothing.
function nextGh(gh: ReviewPrGh, goneAt: string | null, fact: GhFact, now: string): { gh: ReviewPrGh; gone_at: string | null } | null {
  if (gh.state === "merged") return null;
  const closed = gh.state === "closed";
  let next: ReviewPrGh;
  let gone = goneAt;
  if (fact.kind === "push") {
    const seen = Array.isArray(gh.push_deliveries) ? gh.push_deliveries : [];
    if (closed || (fact.delivery && seen.includes(fact.delivery))) return null;
    const same = gh.pushed_at === fact.pushed_at;
    const shas = same ? (Array.isArray(gh.push_shas) ? gh.push_shas : gh.head_sha ? [gh.head_sha] : []) : [];
    if (gh.pushed_at && (fact.pushed_at < gh.pushed_at || shas.includes(fact.head_sha))) return null;
    next = {
      ...gh,
      head_sha: fact.head_sha,
      pushed_at: fact.pushed_at,
      push_deliveries: fact.delivery ? [...seen, fact.delivery].slice(-DELIVERIES_KEPT) : seen,
      push_shas: [...shas, fact.head_sha], // not capped: it starts over with each new second
    };
  } else if (fact.kind === "review") {
    const reviews = Array.isArray(gh.reviews) ? gh.reviews : [];
    const r = fact.review;
    if (closed || reviews.some((x) => x?.login === r.login && x.state === r.state && x.at === r.at)) return null;
    next = { ...gh, reviews: [...reviews, r].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-REVIEWS_KEPT) };
  } else {
    const seen = Array.isArray(gh.state_deliveries) ? gh.state_deliveries : [];
    if (fact.state !== "merged" && ((fact.delivery && seen.includes(fact.delivery)) || (gh.state_at && fact.at < gh.state_at))) return null;
    if (fact.kind === "end") gone = goneAt ?? now;
    // A draft or ready delivery newer than the close means a reopen came in between, still on its way: apply it.
    else if (closed && !fact.reopen && !(gh.state_at && fact.at > gh.state_at)) return null;
    else if (fact.reopen || closed) gone = null;
    next = {
      ...gh,
      state: fact.state,
      state_at: gh.state_at && gh.state_at > fact.at ? gh.state_at : fact.at,
      state_deliveries: fact.delivery ? [...seen, fact.delivery].slice(-DELIVERIES_KEPT) : seen,
    };
  }
  return gone === goneAt && JSON.stringify(next) === JSON.stringify(gh) ? null : { gh: next, gone_at: gone };
}

// Merges `fact` into every routine's row for the url (review_prs_url spans routines) in one db.batch: per routine,
// one UPDATE of its rows, then the routine's head bump, which lands only when that UPDATE changed a row. The UPDATE
// writes all of the routine's rows or none: only while every one still has the url, gh and gone_at it read. When a
// report rewrote one in between, the loop reads that routine's rows again (every fact is idempotent); a routine
// already written is never written again, so each routine gets at most one change row per delivery. `afterRead`
// is a test seam, run once between the first read and its write. Returns the routines it changed.
export async function writeReviewPrs(db: D1Database, url: string, fact: GhFact, now: string, afterRead?: () => Promise<void>): Promise<string[]> {
  const done = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { results } = await db
      .prepare("SELECT routine, number, gh, gone_at FROM review_prs WHERE url = ?")
      .bind(url)
      .all<{ routine: string; number: number; gh: string | null; gone_at: string | null }>();
    if (attempt === 0) await afterRead?.();
    const writes = new Map<string, unknown[]>();
    for (const r of results) {
      if (done.has(r.routine)) continue;
      const parsed: unknown = r.gh ? JSON.parse(r.gh) : null; // json_valid by its CHECK
      const next = nextGh(isObject(parsed) ? (parsed as ReviewPrGh) : {}, r.gone_at, fact, now);
      if (!next) continue;
      const w = { n: r.number, old_gh: r.gh, old_gone: r.gone_at, gh: JSON.stringify(next.gh), gone_at: next.gone_at };
      writes.set(r.routine, [...(writes.get(r.routine) ?? []), w]);
    }
    if (!writes.size) break;
    const routines = [...writes.keys()];
    const res = await db.batch(
      routines.flatMap((routine) => [
        db
          .prepare(
            `WITH w AS (
               SELECT json_extract(value, '$.n') AS n, json_extract(value, '$.old_gh') AS old_gh,
                 json_extract(value, '$.old_gone') AS old_gone, json_extract(value, '$.gh') AS gh,
                 json_extract(value, '$.gone_at') AS gone_at
               FROM json_each(?2))
             UPDATE review_prs SET gh = w.gh, gone_at = w.gone_at, updated_at = ?3
             FROM w
             WHERE review_prs.routine = ?1 AND review_prs.number = w.n
               -- Every row as it was read, or none is written.
               AND NOT EXISTS (SELECT 1 FROM w AS x LEFT JOIN review_prs AS p
                   ON p.routine = ?1 AND p.number = x.n AND p.url = ?4 AND p.gh IS x.old_gh AND p.gone_at IS x.old_gone
                 WHERE p.number IS NULL)`,
          )
          .bind(routine, JSON.stringify(writes.get(routine)), now, url),
        // changes() is the rows the UPDATE just before it changed.
        headBump(db, { routine, actor: ACTOR, now, when: "changes() > 0" }),
      ]),
    );
    routines.forEach((routine, i) => {
      if ((res[2 * i].meta.changes ?? 0) > 0) done.add(routine);
    });
    if (routines.every((r) => done.has(r))) break;
  }
  return [...done];
}

class Skip extends Error {}

export async function githubHook(request: Request, env: Env): Promise<Response> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "unavailable", "GITHUB_WEBHOOK_SECRET is not set");
  const raw = await readBytes(request);
  const given = request.headers.get("x-hub-signature-256") ?? "";
  if (!safeEqual(given, `sha256=${await hmacHex(secret, raw)}`)) throw unauthorized("Bad signature");

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw badRequest("Body is not valid JSON");
  }
  const now = new Date().toISOString();
  const delivery = request.headers.get("x-github-delivery") ?? "";
  const ev = isObject(payload) ? prEvent(request.headers.get("x-github-event"), delivery, payload, now) : null;
  if (!ev) return json({ ignored: true }, 202);

  const { url, state, fact } = ev;
  const db = env.DB;
  const updated: { collection: string; id: string }[] = [];
  // Each write is pinned on the version it read (mutate retries a lost race),
  // and re-checks the match in case the doc changed in between.
  const write = async <T>(collection: string, id: string, build: (d: T) => T) => {
    try {
      await mutate<T>(db, collection, id, { actor: ACTOR, now }, (cur) => {
        if (!cur) throw new Skip();
        return build(cur.data);
      });
      updated.push({ collection, id });
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
    }
  };

  if (state) {
    for (const id of await linkedIds(db, "items", url)) {
      await write<Item>("items", id, (d) => {
        if (!itemLinksTo(d, url)) throw new Skip();
        // Closing is decided on the delivery itself, not on pr_state, which may
        // already read merged (written ahead of the webhook): an open pr_ready
        // item is done once its PR merges; an open item posted with close_on_pr
        // asks about its PR, so it ends when the PR merges or closes. Not an
        // auto_decided one: its decision is the agent's call.
        const ends =
          d.status === "open" &&
          ((d.type === "pr_ready" && state === "merged") ||
            (d.close_on_pr === true && d.type !== "auto_decided" && (state === "merged" || state === "closed")));
        const moves = advances(d.pr_state, state);
        if (!ends && !moves) throw new Skip();
        const next: Item = { ...d, updated_at: now };
        if (moves) next.pr_state = state as Item["pr_state"];
        if (ends) {
          next.status = "archived";
          next.decision =
            state === "merged"
              ? { choice: "merged", ended: "merged", note: "Merged on GitHub", decided_at: now, by: ACTOR }
              : { choice: "closed", ended: "closed", note: "Closed on GitHub without merging", decided_at: now, by: ACTOR };
        }
        return next;
      });
    }
    for (const id of await linkedIds(db, "orchestrators", url)) {
      await write<Orchestrator>("orchestrators", id, (d) => {
        if (!orchestratorLinksTo(d, url) || !advances(d.pr?.state, state)) throw new Skip();
        return { ...d, pr: { ...d.pr, state }, updated_at: now };
      });
    }
  }
  if (fact) for (const id of await writeReviewPrs(db, url, fact, now)) updated.push({ collection: "reviews", id });
  return json({ updated });
}
