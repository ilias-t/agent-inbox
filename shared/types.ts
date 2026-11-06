// Wire types shared by the Worker, the UI and (as documentation) the CLI.
// Field meanings follow the artifact inbox's data model; see docs/api.md.

export type ItemType = "proposal" | "decision" | "pr_ready" | "blocker" | "info" | "auto_decided";
export type ItemStatus = "open" | "decided" | "processing" | "archived";
export type Priority = "high" | "normal" | "low";
export type Confidence = "high" | "medium" | "low";

export interface Link {
  label: string;
  url: string;
}

export interface Option {
  id: string;
  label: string;
  description?: string;
  consequence?: string;
  tradeoff?: string;
  reversible?: boolean;
}

export interface Recommendation {
  option: string;
  confidence?: Confidence;
  why?: string;
}

export interface Decision {
  choice: string; // an option id, "other", "override", or "withdrawn" (withdraw) / "merged" / "closed" (GitHub hook)
  note?: string;
  decided_at: string;
  by?: string; // actor who decided (set by the server)
  // Set by the server when the item ended without an answer: its asker withdrew it, or the GitHub
  // hook closed it with its PR. Says so even when an option shares the choice's id.
  ended?: "withdrawn" | "merged" | "closed";
}

export interface Item {
  type: ItemType;
  title: string;
  summary?: string;
  context?: string;
  steps?: string; // markdown: what the human has to do (commands, links), apart from the briefing
  command?: string; // one shell command for the human to run, pasted as `! <command>` into the asking session
  question?: string;
  recommendation?: Recommendation;
  recommended?: string; // legacy form of recommendation.option
  cost_of_waiting?: string;
  evidence?: Link[];
  orchestrator?: string;
  assignee?: string; // email of the human it's routed to; absent = unassigned
  priority?: Priority;
  links?: Link[];
  options?: Option[];
  status: ItemStatus;
  decision?: Decision;
  override_of?: string;
  created_at?: string;
  updated_at?: string;
  source?: string;
  qa_pending?: boolean;
  qa_last_at?: string;
  qa_answered_at?: string;
  // Set by the GitHub webhook when a linked PR changes.
  pr_state?: "open" | "merged" | "closed" | "approved" | "changes_requested" | "commented";
  // The question is about the linked PR: the GitHub webhook archives the item
  // while open when that PR merges or closes (decision "merged" / "closed").
  close_on_pr?: boolean;
  // Set by the orchestrator's claim (POST /api/items/:id/claim): when, and which orchestrator session (its
  // X-Lease-Session) when it named one. reclaimed_from: the session a re-taken item came from (null: one unnamed).
  claimed_at?: string;
  claimed_by?: string;
  reclaimed_from?: string | null;
  // The fleet it belongs to (docs/api.md "Fleets"); absent for the default fleet. Stamped by the server on token
  // writes; only an admin human moves it.
  fleet?: string;
  [extra: string]: unknown;
}

export type QaRole = "user" | "manager" | "orchestrator";

export interface QaMessage {
  role: QaRole;
  text: string;
  created_at: string;
  by?: string; // actor (set by the server)
}

export interface Orchestrator {
  id?: string;
  fleet?: string; // as on Item: absent for the default fleet
  goal?: string;
  status?: string; // proposed · approved · running · blocked · pr-open · parked · done · dropped
  headline?: string;
  motivation?: string;
  summary?: string;
  asks?: string;
  pr?: { number?: number; url?: string; state?: string };
  session_title?: string;
  session_url?: string;
  session_id?: string; // the Claude session uuid; `orch relink` resolves session_url from it
  session_live?: boolean; // set by `orch relink`: false when no running session has this manager's id, so the link may not open it
  session_url_at?: string; // when session_url was last changed by `orch relink`
  updated_at?: string;
  [extra: string]: unknown;
}

export interface ManagerMeta {
  last_tick?: string;
  last_pickup?: string;
  next_tick?: string;
  digest?: string;
  tick_requested_at?: string;
  tick_requested_note?: string | null;
  // Legacy mirrors of the schedule; meta/schedule is the source of truth.
  work_hours?: string;
  timezone?: string;
  pickup_interval_min?: number;
  sweep_interval_min?: number;
  [extra: string]: unknown;
}

export interface Lease {
  holder_session_id: string;
  holder_title?: string;
  holder_url?: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

// Opt-in lease check on writes (docs/api.md "Lease-checked writes"): a
// manager-token write carrying this header with the caller's session id lands
// only while that session holds a fresh meta/lease; otherwise 409 lease_held
// with the lease as `current`. Absent, nothing changes. Header names are
// case-insensitive; this is the spelling the docs use.
export const LEASE_SESSION_HEADER = "X-Lease-Session";
export const LEASE_SESSION_MAX = 200;

export interface Schedule {
  work_hours: string; // "HH:MM-HH:MM Ddd-Ddd", e.g. "10:00-18:00 Mon-Fri"
  timezone: string; // IANA zone
  pickup_interval_min: number;
  sweep_interval_min: number;
}

export const DEFAULT_SCHEDULE: Schedule = {
  work_hours: "10:00-18:00 Mon-Fri",
  timezone: "America/New_York",
  pickup_interval_min: 10,
  sweep_interval_min: 30,
};

export interface ScheduleView {
  schedule: Schedule;
  version: number | null; // null while meta/schedule has never been written (defaults)
  stored_invalid?: true; // meta/schedule exists but doesn't validate; `schedule` is the defaults
  computed: {
    now: string;
    in_hours: boolean;
    next_pickup_at: string | null; // next pickup slot (now-aligned inside hours, next window start outside)
    next_window_start: string | null;
    label: string; // "10:00–18:00 ET, Mon–Fri"
    utc_offset_min: number; // zone offset now, e.g. -240 for EDT
    cron_utc: string[]; // 5-field cron expression(s) in UTC for pickups, e.g. ["3-59/10 14-21 * * 1-5"]
    // False when cron_utc is a superset (window or zone offset not on whole
    // hours): the manager must skip firings while in_hours is false.
    cron_exact: boolean;
  };
}

// A stored document as the API returns it.
export interface Doc<T = Record<string, unknown>> {
  id: string;
  version: number;
  data: T;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface Change {
  seq: number;
  collection: string; // "items" | "orchestrators" | "meta" | "items/<id>/qa" | "users" | "snoozes" | "pins" | "reviews"
  doc_id: string;
  op: "create" | "update" | "delete";
  version: number | null;
  status: string | null;
  actor: string; // "human:<email>" | "token:<name>" | "hook:<source>"
  at: string;
}

export interface ChangesResponse {
  cursor: number; // pass back as ?since=
  changes: Change[];
}

// One human's snoozes (POST /api/items/:id/snooze): item id → when it comes back, ISO 8601.
export type Snoozes = Record<string, string>;

export interface SnoozeResponse {
  item_id: string;
  until: string | null;
}

// What a human can pin (PUT /api/pins/<kind>/<ref>): an item (any status), an orchestrator, a Reviews PR.
export type PinKind = "item" | "orch" | "pr";
// One human's pins: "<kind>:<ref>" → when it was pinned, ISO 8601. A PR's ref is "<routine>/<n>".
export type Pins = Record<string, string>;

export interface PinResponse {
  kind: PinKind;
  ref: string;
  pinned: boolean;
  created_at: string | null; // when it was pinned; null once unpinned
}

export interface StateResponse {
  items: Doc<Item>[];
  orchestrators: Doc<Orchestrator>[];
  manager: Doc<ManagerMeta> | null;
  lease: Doc<Lease> | null;
  schedule: ScheduleView;
  cursor: number;
  me: Principal;
  people: Person[]; // empty for orchestrator tokens
  // The caller's own snoozes still to come, item id → until (ISO). Per person: empty for tokens.
  snoozes: Snoozes;
  // The caller's own pins (migration 0010). Per person: empty for tokens. Optional: a Worker from before pins, and
  // snapshots saved by one, don't have it.
  pins?: Pins;
  // Archived items the caller can see, all of them, whether or not `items` holds them all.
  archived_total: number;
  // With `?archived=n`: true when `items` leaves archived items out (older ones page in from GET /api/items).
  archived_more: boolean;
  // Every routine that has reported, as the Reviews tab's nav gate (docs/reviews.md). Orchestrator tokens get
  // only their own. Optional: a Worker from before migration 0009, and snapshots saved by one, don't have it.
  routines?: RoutineState[];
}

// GET /api/state/delta?since=<cursor>: what changed in the caller's /api/state since a cursor (docs/api.md,
// "State delta"). Optional fields are present only when they changed: present means replace (null included).
export interface StateDelta {
  cursor: number; // the next ?since=, the same cursor a fresh /api/state would report
  items: Doc<Item>[]; // current version of every item that changed (upsert by id)
  orchestrators: Doc<Orchestrator>[];
  deleted: { collection: "items" | "orchestrators"; id: string }[]; // gone, or no longer visible to the caller
  qa_changed: string[]; // item ids whose qa thread changed (refetch it if open)
  manager?: Doc<ManagerMeta> | null;
  lease?: Doc<Lease> | null;
  schedule?: ScheduleView;
  people?: Person[];
  snoozes?: Snoozes; // the caller's whole map, when any of their snoozes changed
  pins?: Pins; // the caller's whole map, when any of their pins changed
  me: Principal;
  archived_total?: number; // when an item may have entered or left the archive
  reviews_changed?: string[]; // routine ids whose review data changed: refetch GET /api/reviews/:routine if shown
  routines?: RoutineState[]; // the whole list, as in /api/state, when reviews_changed is present
}

// Too far behind (changes pruned, or more than the cap): fetch /api/state instead.
export interface StateDeltaReset {
  reset: true;
}

export type StateDeltaResponse = StateDelta | StateDeltaReset;

// What each human sets for themselves (/api/people/me), stored on their users row.
export interface PersonSettings {
  name?: string;
  ntfy_topic?: string;
}

// A person as others see them: the topic itself stays private.
export interface Person {
  email: string;
  name?: string;
  has_topic: boolean;
}

// A human's role (docs/deploy.md, "People and roles"): admin does everything;
// decider reads, decides, asks, requests ticks and reassigns; viewer reads.
// Everyone keeps their own profile and devices.
export type Role = "admin" | "decider" | "viewer";
export const ROLES: Role[] = ["admin", "decider", "viewer"];

// GET /api/users. Admins get the whole entry; everyone else email, name and role.
export interface UserInfo {
  email: string;
  name?: string;
  role: Role; // the role in effect: the saved one, or the default when role_set is false
  role_set?: boolean; // admins only: an admin saved this role
  // Admins only: false for someone listed only because they have Web Push devices
  // (no users row: no role, name or topic saved). DELETE removes those devices.
  has_row?: boolean;
  devices?: number; // admins only: Web Push subscriptions stored for this email
  has_topic?: boolean; // admins only
  created_at?: string; // admins only
  updated_at?: string; // admins only
}
export interface UsersResponse {
  users: UserInfo[];
  // Admins only: no admin is saved yet, so humans without a row are admins
  // (or deciders, with ADMIN_EMAILS set). The first admin-made change saves its author as admin.
  bootstrap?: boolean;
}

export type Principal =
  // is_admin (role === "admin") is kept for clients from before roles.
  | { kind: "human"; email: string; role: Role; is_admin: boolean }
  // fleet: the token's fleet, "default" for the default fleet (docs/api.md "Fleets"). Optional: a Worker from
  // before fleets doesn't send it.
  | { kind: "token"; name: string; scope: "manager"; fleet?: string }
  | { kind: "token"; name: string; scope: "orchestrator"; orchestrator: string; fleet?: string };

// How the API names the default fleet: the fleet of every doc and token that has none (docs/api.md "Fleets").
export const DEFAULT_FLEET = "default";
// A named fleet's id; "default" is reserved.
export const FLEET_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface TokenInfo {
  id: string;
  name: string;
  scope: "manager" | "orchestrator";
  orchestrator: string | null;
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiError {
  error: string; // machine code: "conflict", "not_found", "forbidden", "unauthorized", "bad_request", "not_open", "not_decided", "lease_held" (also a lease-checked write whose session lost the lease), "decided" (a token's write would change a decided item's status or decision), "last_admin"
  message: string;
  current?: Doc | ReviewRun | null; // on 409: the document (for /api/reviews/report, the run) as it is now
}

// --- Reviews (docs/reviews.md) ------------------------------------------------
// A review routine's runner reports each run; the Worker keeps its runs, the current state of every PR it tracks,
// and per-PR events. `routine` is always the writing token's orchestrator id. The report's shape is docs/reviews.md
// "The report" (schema 1) plus `asks` and `resolved` (schema 2); shared/reviews.ts validates it.

export type ReviewRole = "reviewing" | "mine" | "bot";
export type ReviewStatus =
  | "held_product"
  | "held_owner"
  | "held_ci"
  | "awaiting_ok"
  | "changes_requested"
  | "waiting_author"
  | "pending"
  | "approved"
  | "mine_action"
  | "mine_waiting"
  | "mine_ready"
  | "mine_draft"
  | "bot";
export type ReviewRisk = "low" | "medium" | "high";
export type ReviewAction = "approved" | "changes_requested" | "commented" | "replied" | "drafted" | "none";
export type ReviewCiState = "passing" | "failing" | "pending" | "none";
export type ReviewMergeable = "clean" | "blocked" | "conflicts" | "behind" | "unknown";
export type ReviewerState = "approved" | "changes_requested" | "commented" | "requested";
export type ReviewHold = "product" | "owner" | "ci" | "post";
export type ReviewPostEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; // the GitHub review event of a post ask

// `running` only comes from POST /reviews/runs/:stamp/start; a report carries one of the others.
export type ReviewRunResult = "running" | "ok" | "failed" | "timed_out" | "report_invalid" | "seed";

export interface ReviewNeedsYou {
  ask: string;
  facts?: string[]; // ≤ 3
  options?: string[]; // ≤ 4
}

// One tracked PR in a report, as the run wrote it. Stored as is (unknown extra fields included).
export interface ReviewPr {
  number: number;
  title: string;
  url: string; // https; the GitHub hook's match key (stored with trailing slashes trimmed)
  author: string;
  role: ReviewRole;
  status: ReviewStatus;
  base?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  status_note?: string | null;
  needs_you?: ReviewNeedsYou | null;
  impact?: string | null;
  risk?: ReviewRisk | null;
  tradeoffs?: string[] | null; // ≤ 3
  risks?: string[] | null; // ≤ 3
  last_action?: { kind?: string | null; at?: string | null; url?: string | null } | null;
  this_run: { action: ReviewAction; url?: string | null; summary?: string | null; changes?: string[] | null }; // changes ≤ 4
  threads?: { open?: number | null; items?: { url?: string | null; where?: string | null; by?: string | null; summary?: string | null }[] | null } | null; // items ≤ 5
  ci?: { state: ReviewCiState; url?: string | null; note?: string | null } | null;
  reviewers?: { login: string; state: ReviewerState }[] | null;
  assignees?: string[] | null;
  mergeable?: ReviewMergeable | null;
  linear?: { id: string; url: string }[] | null;
  links?: Link[] | null; // ≤ 5
  [extra: string]: unknown;
}

// Schema 2: an inbox item the routine wants open now. The runner (never the run) posts it as item
// `<routine>-<key>`; the server only validates and keeps it in the run record.
export interface ReviewAsk {
  key: string; // "<pr>-<hold>", stable while the hold lasts
  type: "decision" | "proposal" | "blocker" | "info";
  priority?: Priority;
  title: string;
  summary?: string;
  question?: string;
  context?: string;
  steps?: string;
  command?: string;
  options: Option[]; // 2-4, unique ids, never "other" (every item offers it)
  recommendation?: Recommendation; // option must be one of options' ids
  cost_of_waiting?: string;
  links?: Link[]; // ≤ 5
  // pr: a PR in the report's prs; pending_review_id (or draft_id, a draft the routine keeps itself), event and head_sha belong to a post ask; also (a product call
  // only): the other PRs the same call covers, one ask for all of them.
  review: { pr: number; hold: ReviewHold; hold_review_id?: number | null; pending_review_id?: number | null; draft_id?: string | null; event?: ReviewPostEvent; head_sha?: string; also?: number[] };
}

// An answer to a question asked on one of the routine's inbox items; the runner posts it to the item's Q&A.
export interface ReviewAnswer {
  id: string;
  text: string;
}

// Schema 2: an inbox item this run acted on (relayed on GitHub); the runner archives it pinned on `version`.
export interface ReviewResolved {
  id: string;
  version: number;
  pr: number;
  review_url?: string | null;
}

// The run's report (docs/reviews.md "The report").
export interface ReviewReport {
  schema?: 1 | 2; // absent reads as 1
  headline?: string | null;
  unverified?: string[] | null; // ≤ 6
  notes?: string[] | null; // ≤ 6
  skipped?: Record<string, number[]> | null;
  prs: ReviewPr[];
  asks?: ReviewAsk[]; // required with schema 2
  resolved?: ReviewResolved[]; // required with schema 2
  answers?: ReviewAnswer[]; // optional: answers to questions asked on the routine's items
  [extra: string]: unknown;
}

// POST /api/reviews/report body: the run's outcome, and its report when it has a valid one.
export interface ReviewReportPayload {
  stamp: string; // the run's UTC stamp, "2026-10-08T180000Z"
  started_at?: string; // ISO; default: the stamp's time
  finished_at?: string; // ISO; default: now
  result: Exclude<ReviewRunResult, "running">;
  exit?: number | null;
  error?: string | null;
  log?: string | null; // where the run's log is, as text the tab shows ("<host>:<path>", a URL)
  notify?: string | null; // a one-line summary the runner sent elsewhere (a chat message, say), kept as is
  model?: string | null;
  dry?: boolean;
  next_run_at?: string | null; // ISO, the routine's next scheduled run
  report: ReviewReport | null; // required for ok and seed, null for report_invalid
}

// POST /api/reviews/runs/:stamp/start body.
export interface ReviewStartPayload {
  started_at?: string; // ISO; default: the stamp's time
  dry?: boolean;
  log?: string | null;
  model?: string | null;
  next_run_at?: string | null;
}

// A run's record (review_runs.data, docs/reviews.md "The run record"), built by the Worker from the payload and report.
export interface ReviewRunRecord {
  stamp: string;
  started: string;
  finished: string | null;
  dry: boolean;
  result: ReviewRunResult;
  exit: number | null;
  error: string | null;
  log: string | null;
  model: string | null;
  headline: string | null;
  notify: string | null;
  schema: number | null; // the report's, null without one
  counts: Partial<Record<ReviewStatus, number>>;
  actions: { pr: number; title: string; action: ReviewAction; url: string | null; summary: string | null }[];
  needs_you: { pr: number; title: string; ask: string }[];
  unverified: string[];
  notes: string[];
  skipped: Record<string, number[]>;
  asks: ReviewAsk[]; // schema 2; [] otherwise
  resolved: ReviewResolved[];
}

export interface ReviewRun {
  routine: string;
  stamp: string;
  started_at: string;
  finished_at: string | null; // null while running
  result: ReviewRunResult;
  dry: boolean;
  has_report: boolean; // false for a run that ended without a valid report (it wrote no PR state)
  report_sha: string | null; // sha256 of the canonical request body, for idempotent replays; null while running
  data: ReviewRunRecord;
}

// Between-run facts from the GitHub hook (docs/reviews.md "GitHub hook"); null until its first delivery for the PR.
export interface ReviewPrGh {
  state?: "open" | "merged" | "closed" | "draft";
  head_sha?: string;
  pushed_at?: string;
  reviews?: { login: string; state: string; at: string }[];
  state_at?: string; // pull_request.updated_at of the newest state delivery applied: an older one never overrides it
  state_deliveries?: string[]; // the last 20 state deliveries' X-GitHub-Delivery ids, so a redelivery is a no-op
  push_deliveries?: string[]; // the same for synchronize deliveries
  push_shas?: string[]; // every head sha pushed within pushed_at's second, so a late one from that second never retakes the head
}

// A PR's current state: the newest report's entry.
export interface ReviewPrRow {
  routine: string;
  number: number;
  url: string;
  role: ReviewRole;
  status: ReviewStatus;
  needs_you: boolean;
  data: ReviewPr;
  last_stamp: string; // the run that wrote it
  gh: ReviewPrGh | null;
  gone_at: string | null; // set when it dropped out of the newest report (merged, closed, stale)
  updated_at: string;
}

// One run's event on one PR (only runs that acted on it or saw changes), built by the Worker from the report.
export interface ReviewEvent {
  routine: string;
  number: number;
  stamp: string;
  data: {
    pr: number;
    stamp: string;
    at: string;
    title: string;
    url: string;
    role: ReviewRole;
    action: ReviewAction;
    review_url: string | null;
    summary: string | null;
    changes: string[];
    status: ReviewStatus;
    status_note: string | null;
    log: string | null;
  };
}

// The routine's head row: every write bumps its version, and its change-log row is the routine's only one.
export interface ReviewRoutineHead {
  routine: string;
  version: number;
  last_stamp: string | null; // newest finished run
  next_run_at: string | null;
  updated_at: string;
  updated_by: string;
  run_request: ReviewRunRequest | null; // the newest on-demand run request, null before the first
}

// A human's request for an on-demand run (docs/reviews.md "Run requests"), kept on the routine's head row. The
// routine's poller moves it from requested to starting (picked up), then started (with the run's stamp), skipped
// (a run was already going) or failed (it couldn't start one).
export type ReviewRunRequestStatus = "requested" | "starting" | "started" | "skipped" | "failed";
export interface ReviewRunRequest {
  id: string;
  status: ReviewRunRequestStatus;
  requested_at: string;
  requested_by: string; // the human's email
  updated_at: string;
  stamp: string | null; // the run it started (status started)
  message: string | null; // the poller's note: what it's waiting for, or why it skipped or failed
}

// POST /api/reviews/run-requests/:id body: the routine's own token reports how the request went.
export interface ReviewRunRequestUpdate {
  status: Exclude<ReviewRunRequestStatus, "requested">;
  stamp?: string; // required for started
  message?: string | null;
}

// GET /api/reviews/:routine/run-request, and every write to it.
export interface ReviewRunRequestResponse {
  request: ReviewRunRequest | null;
}

// /api/state `routines` and the delta's copy.
export interface RoutineState {
  id: string;
  version: number;
  last_run_at: string | null; // finished_at of the newest finished run
  result: ReviewRunResult | null;
}

// GET /api/reviews
export interface ReviewRoutineSummary {
  routine: string;
  version: number;
  last_run: { stamp: string; result: ReviewRunResult; finished_at: string | null; headline: string | null } | null;
  next_run_at: string | null;
  counts: Partial<Record<ReviewStatus, number>>; // current PRs (not gone) by status
  needs_you: number; // current PRs with needs_you set
  running: { stamp: string; started_at: string } | null; // a run started after the newest finished one
}
export interface ReviewsResponse {
  routines: ReviewRoutineSummary[];
}

// GET /api/reviews/:routine
export interface RoutineReviewsResponse {
  routine: ReviewRoutineHead;
  prs: ReviewPrRow[]; // current PRs, plus those gone in the last 7 days (gone_at set)
  runs: ReviewRun[]; // newest first, `limit` of them (default 30)
  more: boolean; // older runs exist: pass the last stamp as ?before=
}

// GET /api/reviews/:routine/prs/:n
export interface ReviewPrResponse {
  pr: ReviewPrRow;
  events: ReviewEvent[]; // newest first, at most 50
}

// POST /api/reviews/report
export interface ReviewReportResponse {
  run: ReviewRun;
  prs_written: number;
  events_written: number;
  gone: number;
  replayed?: true; // the same body was already stored: nothing written
}

// DELETE /api/reviews/:routine
export interface ReviewDeleteResponse {
  ok: true;
  runs: number;
  prs: number;
  events: number;
}
