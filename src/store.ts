import type {
  ChangesResponse, Change, Doc, Item, ManagerMeta, PersonSettings, QaMessage, ReviewPrResponse, ReviewRun, ReviewRunRequestResponse, Role, RoutineReviewsResponse, Schedule, ScheduleView,
  SnoozeResponse, StateDeltaResponse, StateResponse, TokenInfo, UserInfo, UsersResponse, PinKind, PinResponse,
} from "../shared/types.ts";
import { DeltaMismatch, deletedItems, mergeDelta, type Synced } from "./lib/delta.ts";

/* ---------- store: the only code that talks to the server ---------- */
// Every read, write and the live-update loop goes through this module (same-origin /api, Cloudflare Access cookie).
// It plays the part of the artifact's `store` object; the rendering above it is the artifact's.

export class ApiError extends Error {
  status: number; // 0 = network
  code: string;
  current: Doc | null;
  constructor(status: number, code: string, message: string, current: Doc | null = null) {
    super(message);
    this.status = status; this.code = code; this.current = current;
  }
}

// Called once when the Access session is gone (401, or Access redirecting the request to its login page).
let signedOutHandler: () => void = () => {};
let signedOut = false;
export function onSignedOut(fn: () => void): void { signedOutHandler = fn; }
function markSignedOut(): void {
  if (signedOut) return;
  signedOut = true; signedOutHandler();
}

// Bumped when a write starts and when it answers, so a /api/state refetch that overlaps one is dropped as stale.
let writeSeq = 0;

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  if (method !== "GET") writeSeq++;
  try {
    res = await fetch(path, {
      method, signal, redirect: "manual", cache: "no-store",
      // Every browser write carries the JSON content type (the Worker's CSRF rule), bodyless DELETEs included.
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "Network error");
  }
  if (method !== "GET") writeSeq++;
  if (res.type === "opaqueredirect" || res.status === 401) {
    markSignedOut();
    throw new ApiError(401, "unauthorized", "Signed out");
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const j = (json || {}) as { error?: string; message?: string; current?: Doc | null };
    throw new ApiError(res.status, j.error || "http_" + res.status, j.message || res.statusText || "Request failed", j.current ?? null);
  }
  return json as T;
}

const enc = encodeURIComponent;
// A PR's ref is "<routine>/<n>": two path segments.
const pinPath = (kind: PinKind, ref: string) => {
  const i = ref.lastIndexOf("/");
  return kind === "pr" && i > 0 ? "pr/" + enc(ref.slice(0, i)) + "/" + enc(ref.slice(i + 1)) : kind + "/" + enc(ref);
};

// /api/state holds every open/decided/processing item but only this many archived ones (the most recently updated):
// History pages older ones in with listItems, so the snapshot refetched on every change stops growing with history.
export const STATE_ARCHIVED = 100;

export interface ItemPage { items: Doc<Item>[]; more?: boolean }

const loadState = () => call<StateResponse>("GET", "/api/state?archived=" + STATE_ARCHIVED);

// Brings the held /api/state up to date: GET /api/state/delta from its cursor merged in (src/lib/delta.ts), a few
// docs instead of the whole snapshot. The full /api/state instead when nothing is held, the server asks for a reset,
// answers the delta with an error (404 from a server deployed before it, mid-deploy), or the delta can't be merged.
// A signed-out session or no network at all is thrown, not retried as a full fetch.
async function sync(held: StateResponse | null): Promise<Synced> {
  if (held) {
    let d: StateDeltaResponse | null = null;
    try {
      d = await call<StateDeltaResponse>("GET", "/api/state/delta?since=" + held.cursor);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 0 || e.status === 401) throw e;
    }
    if (d && typeof d === "object" && !("reset" in d)) {
      try {
        const state = mergeDelta(held, d); // checks the body first
        return { full: false, state, deleted: deletedItems(d), qa: d.qa_changed };
      } catch (e) {
        if (!(e instanceof DeltaMismatch)) throw e;
      }
    }
  }
  return { full: true, state: await loadState() };
}

export const store = {
  loadState,
  sync,
  getItem: (id: string) => call<Doc<Item>>("GET", "/api/items/" + enc(id)),
  // GET /api/items with filters; `limit`/`before`/`before_id` page newest first, `q` searches (docs/api.md).
  listItems: (params: Record<string, string | number>, signal?: AbortSignal) =>
    call<ItemPage>("GET", "/api/items?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(), undefined, signal),
  // Atomic on the server: 409 not_open (with current) when someone else got there first. Pinned on the version the page
  // shows, so 409 conflict (with current) when the item changed since: the decision is bound to what the human saw.
  decide: (id: string, choice: string, note: string, ifVersion: number | undefined) =>
    call<Doc<Item>>("POST", "/api/items/" + enc(id) + "/decide", ifVersion == null ? { choice, note } : { choice, note, if_version: ifVersion }),
  // A follow-up question: the thread message and the item's qa_pending flag in one transaction. Never changes status.
  // Unpinned, so an answer landing meanwhile doesn't refuse it; pinned (409 conflict with current) when the page
  // shows a saved snapshot the server hasn't confirmed yet.
  ask: (id: string, text: string, ifVersion?: number) =>
    call<{ message: Doc<QaMessage>; item: Doc<Item> }>("POST", "/api/items/" + enc(id) + "/qa", ifVersion == null ? { text } : { text, if_version: ifVersion }),
  listQa: async (id: string) => (await call<{ messages: Doc<QaMessage>[] }>("GET", "/api/items/" + enc(id) + "/qa")).messages,
  // Pinned merge, e.g. {assignee} to reassign (null unassigns): 409 conflict (with current) if it changed meanwhile.
  patchItem: (id: string, data: Record<string, unknown>, ifVersion: number | undefined) =>
    call<Doc<Item>>("PATCH", "/api/items/" + enc(id), ifVersion == null ? { data } : { data, if_version: ifVersion }),
  // Hide an open item from the signed-in human's own Inbox until `until` (ISO), or wake it (null). Humans only.
  // Per person and off the item doc: no version pin, and nobody else's Inbox changes.
  snooze: (id: string, until: string | null) => call<SnoozeResponse>("POST", "/api/items/" + enc(id) + "/snooze", { until }),
  // Keep an item, orchestrator or Reviews PR ("<routine>/<n>") at the top of the signed-in human's own list, or stop.
  // Humans only, per person like snooze.
  pin: (kind: PinKind, ref: string, on: boolean) => call<PinResponse>(on ? "PUT" : "DELETE", "/api/pins/" + pinPath(kind, ref)),
  // The signed-in human's own name and ntfy topic (others only ever see the name).
  getMyPerson: () => call<PersonSettings & { email: string }>("GET", "/api/people/me"),
  putMyPerson: (p: PersonSettings) => call<PersonSettings & { email: string }>("PUT", "/api/people/me", p),
  // People and roles (Settings → People). Only admins write; the last saved admin can't be demoted or removed (409 last_admin).
  listUsers: () => call<UsersResponse>("GET", "/api/users"),
  putUser: (email: string, body: { role?: Role; name?: string | null }) => call<UserInfo>("PUT", "/api/users/" + enc(email), body),
  deleteUser: (email: string) => call<{ ok: true }>("DELETE", "/api/users/" + enc(email)),
  requestTick: (note: string) => call<Doc<ManagerMeta>>("POST", "/api/meta/manager/tick-request", { note: note || null }),
  getSchedule: () => call<ScheduleView>("GET", "/api/schedule"),
  putSchedule: (schedule: Schedule, ifVersion: number | null) =>
    call<ScheduleView>("PUT", "/api/schedule", ifVersion == null ? { schedule } : { schedule, if_version: ifVersion }),
  listTokens: async () => (await call<{ tokens: TokenInfo[] }>("GET", "/api/tokens")).tokens,
  createToken: (name: string, scope: "manager" | "orchestrator", orchestrator: string | null) =>
    call<{ token: TokenInfo; secret: string }>("POST", "/api/tokens", orchestrator ? { name, scope, orchestrator } : { name, scope }),
  revokeToken: (id: string) => call<{ ok: true }>("DELETE", "/api/tokens/" + enc(id)),
  // Web Push for this device (Settings → Notifications): the server's VAPID key, and the caller's own subscriptions.
  getPushKey: async () => (await call<{ key: string }>("GET", "/api/push/key")).key,
  subscribePush: (sub: PushSubscriptionJSON) => call<{ ok: true }>("POST", "/api/push/subscribe", sub),
  unsubscribePush: (endpoint: string) => call<{ ok: true; removed: number }>("DELETE", "/api/push/subscribe", { endpoint }),
  testPush: () => call<{ sent: number; failed: number; removed: number }>("POST", "/api/push/test", {}),
  // Reviews (docs/reviews.md): a routine's current PRs and newest runs, and one run by its stamp.
  reviews: (routine: string, page: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams(Object.entries(page).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return call<RoutineReviewsResponse>("GET", "/api/reviews/" + enc(routine) + (q ? "?" + q : ""));
  },
  reviewPr: (routine: string, n: number) => call<ReviewPrResponse>("GET", "/api/reviews/" + enc(routine) + "/prs/" + n),
  reviewRun: (routine: string, stamp: string) => call<ReviewRun>("GET", "/api/reviews/" + enc(routine) + "/runs/" + enc(stamp)),
  // The Run button: asks the routine's poller for one run (409 while one is asked for or going).
  askRun: (routine: string) => call<ReviewRunRequestResponse>("POST", "/api/reviews/" + enc(routine) + "/run-request", {}),
  watch,
};

/* ---------- live updates ---------- */
// Long-poll /api/changes; when anything changed, sync the held state (debounced): a delta of /api/state, else the
// whole of it. Backs off 1s → 30s on errors, pauses while the tab is hidden, retries at once when the device comes
// back online, and stops for good on 401. Back in the foreground it first asks the feed with wait=0 (a few hundred
// bytes), and syncs only when that finds changes.
export interface WatchHandlers {
  // The /api/state the page holds now (deltas merged in): what a sync starts from.
  base(): StateResponse | null;
  onSync(r: Synced): void;
  onChanges(changes: Change[]): void;
  // network: the failures were the network (no answer at all), not the server answering with an error.
  onHealth(h: "failing" | "recovered", network: boolean): void;
}
const WAIT_S = 20;
const FAIL_TOAST_AFTER = 4;

function watch(cursor: number, h: WatchHandlers): () => void {
  let since = cursor, stopped = false, fails = 0;
  let ctrl: AbortController | null = null;
  // The next request asks with wait=0: the page just came back to the foreground.
  let check = false;
  let wake: (() => void) | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | undefined, refetching = false, refetchAgain = false;

  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  const visible = () => new Promise<void>((r) => { if (!document.hidden) r(); else wake = r; });

  async function refetch(): Promise<void> {
    if (refetching) { refetchAgain = true; return; }
    refetching = true;
    try {
      for (let tries = 0; tries < 3; tries++) {
        const seq = writeSeq;
        const r = await sync(h.base());
        if (stopped) return;
        if (seq === writeSeq) { // otherwise a write landed meanwhile: read again
          h.onSync(r);
          // The sync covers every change up to its cursor: a long-poll from before it would report them again.
          if (r.state.cursor > since) { since = r.state.cursor; ctrl?.abort(); }
          break;
        }
      }
    } catch { /* the poll loop surfaces persistent failures */ }
    finally {
      refetching = false;
      if (refetchAgain && !stopped) { refetchAgain = false; scheduleRefetch(); }
    }
  }
  function scheduleRefetch(ms = 250): void {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(refetch, ms);
  }

  function onVisibility(): void {
    if (document.hidden) { ctrl?.abort(); return; }
    check = true;
    // A long-poll that lived through the background (no hidden event, or a frozen page) may be dead: start over.
    ctrl?.abort();
    const w = wake; wake = null; w?.();
  }
  document.addEventListener("visibilitychange", onVisibility);
  // Back online: skip the rest of the backoff.
  function onOnline(): void { const w = wake; wake = null; w?.(); }
  window.addEventListener("online", onOnline);

  (async function loop() {
    while (!stopped && !signedOut) {
      if (document.hidden) { await visible(); continue; }
      ctrl = new AbortController();
      const c = ctrl, quick = check;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; c.abort(); }, (WAIT_S + 15) * 1000);
      check = false;
      try {
        const r = await call<ChangesResponse>("GET", "/api/changes?since=" + since + "&wait=" + (quick ? 0 : WAIT_S), undefined, c.signal);
        if (fails >= FAIL_TOAST_AFTER) h.onHealth("recovered", false);
        fails = 0;
        if (r.cursor > since || r.changes.length) {
          since = Math.max(since, r.cursor);
          if (r.changes.length) h.onChanges(r.changes);
          scheduleRefetch(quick ? 0 : 250);
        }
      } catch (e) {
        if (stopped || signedOut) break;
        // Aborted because the tab went hidden, or to make way for the foreground check: not a failure.
        if (e instanceof DOMException && e.name === "AbortError" && !timedOut) continue;
        fails++;
        // ApiError status 0 is a network error; anything else thrown here is the abort after WAIT_S + 15 s without an answer.
        if (fails === FAIL_TOAST_AFTER) h.onHealth("failing", !(e instanceof ApiError) || e.status === 0);
        await sleep(Math.min(30000, 1000 * 2 ** (fails - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  })();

  return () => {
    stopped = true; ctrl?.abort(); clearTimeout(refetchTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    const w = wake; wake = null; w?.();
  };
}
