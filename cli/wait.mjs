// `agent-inbox wait`: long-poll /api/changes until a matching change arrives.
// The manager's cheap wake path, so it retries transient failures with
// backoff and never spins: the server holds each poll up to 25 s, and a poll
// that comes back empty and fast is followed by a pause.

import { isRetryable } from "./http.mjs";

const MAX_SERVER_WAIT_S = 25;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const EMPTY_POLL_PAUSE_MS = 2_000;

// Actors that mean "the human did something": the browser, or an ntfy action button.
export function isHumanActor(actor) {
  return typeof actor === "string" && (actor.startsWith("human:") || actor === "hook:ntfy");
}

// {human, actors, statuses, ids, ops} → (change) => boolean. Filters AND together;
// --human and --actor OR within the actor test. --human skips a human's Run-button
// request on a review routine (collection reviews): it's for the routine's own poller,
// and waking the orchestrator for it would spend a pickup on nothing.
export function changeMatcher({ human = false, actors, statuses, ids, ops } = {}) {
  return (c) => {
    if (human || actors?.length) {
      const ok = (human && isHumanActor(c.actor) && c.collection !== "reviews") || (actors ?? []).some((p) => c.actor?.startsWith(p));
      if (!ok) return false;
    }
    if (statuses?.length && !statuses.includes(c.status)) return false;
    if (ids?.length && !ids.includes(c.doc_id)) return false;
    if (ops?.length && !ops.includes(c.op)) return false;
    return true;
  };
}

// → {cursor, changes, timed_out}. `changes` holds the matching changes of the
// batch that matched; `cursor` is that batch's cursor (pass it back as since).
export async function waitForChanges(api, opts, io) {
  const { since, collection, fleet, match = () => true, timeoutMs = 0, pollWaitS = MAX_SERVER_WAIT_S } = opts;
  const { sleep, now, log = () => {} } = io;
  const deadline = timeoutMs > 0 ? now() + timeoutMs : Infinity;
  let cursor = since;
  let backoff = MIN_BACKOFF_MS;

  // One GET with retries on network errors, 5xx and 429; null at the deadline.
  async function poll(query, waitS) {
    for (;;) {
      if (now() >= deadline) return null;
      try {
        const res = await api("GET", "/api/changes", { query, timeoutMs: (waitS + 15) * 1000 });
        backoff = MIN_BACKOFF_MS;
        return res;
      } catch (err) {
        if (!isRetryable(err)) throw err;
        const pause = Math.min(backoff * (0.75 + Math.random() * 0.5), Math.max(0, deadline - now()));
        log(`wait: ${err.message}; retrying in ${Math.round(pause / 1000)}s`);
        await sleep(pause);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  if (cursor === undefined) {
    const res = await poll({ collection, fleet }, 0);
    if (!res) return { cursor: null, changes: [], timed_out: true };
    cursor = res.cursor;
  }

  for (;;) {
    const remainingS = Math.floor((deadline - now()) / 1000);
    if (remainingS <= 0 && deadline !== Infinity) return { cursor, changes: [], timed_out: true };
    const waitS = Math.max(0, Math.min(pollWaitS, remainingS));
    const started = now();
    const res = await poll({ since: cursor, wait: waitS, collection, fleet }, waitS);
    if (!res) return { cursor, changes: [], timed_out: true };
    const changes = Array.isArray(res.changes) ? res.changes : [];
    cursor = Math.max(cursor, Number.isInteger(res.cursor) ? res.cursor : cursor, ...changes.map((c) => c.seq));
    const matches = changes.filter(match);
    if (matches.length) return { cursor, changes: matches, timed_out: false };
    if (changes.length === 0 && now() - started < 1_000) {
      await sleep(Math.min(EMPTY_POLL_PAUSE_MS, Math.max(0, deadline - now())));
    }
  }
}
