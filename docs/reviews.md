# Reviews API contract

The Reviews tab shows what a **review routine** did on each run, and where every PR it tracks stands. A review routine is a PR reviewer you run yourself: an agent, a script, a CI job, anything that reviews a set of PRs now and then. Its **runner** is the program around it that talks to the Worker: it reports each run, posts the asks a run raises as Inbox items, and (if you want the tab's Run button) polls for on-demand run requests. The Worker keeps three things per routine: its runs, the current state of each PR, and one event per PR per run that touched it.

This file is the contract a runner implements. [api.md](api.md) indexes the endpoints, `shared/types.ts` holds the wire types, and `shared/reviews.ts` validates every body. The report a run produces is defined under "The report" below (schema 1, plus `asks` and `resolved` in schema 2).

Review holds that need a human don't live here. The runner posts them as ordinary decision items (`asks`, below), so they reach the Inbox, push and Focus like any other item. Reviews only shows what happened.

## Writing a runner

A runner needs a manager token for its routine and makes these calls, all with that token. The routine id is the token's manager id; no call names it.

1. **Get a token.** Pick a routine id (`review-bot`, say) and mint a manager token for it: **Settings → Agent tokens**, kind Manager, manager id `review-bot`, name `orch-review-bot`; or `node scripts/create-token.mjs --name orch-review-bot --scope orchestrator --orchestrator review-bot --remote` ([cli.md](cli.md#tokens-and-scopes); without `--remote` it writes your local dev database). An id ending in `-dry` is a dry-run routine: the tab labels its button "Run dry review", and opens on a routine that isn't one when there is any. Give dry runs their own routine and token (`review-bot-dry`), so they never touch the real routine's PRs.
2. **Start a run** (optional, best effort). Make a run stamp, `date -u +%Y-%m-%dT%H%M%SZ`, and post `POST /reviews/runs/:stamp/start`. The tab then shows the run as going.
3. **Run the review** and build its report (below).
4. **Report the run**, whatever happened: `POST /reviews/report` with the stamp, the result and the report. A run that failed or produced a bad report still gets a run record.
5. **Reconcile the Inbox** from the report's `asks`, `resolved` and `answers` (schema 2, below): post each ask as an item, archive the items the run acted on, answer questions on them.
6. **Poll for run requests** (optional): about once a minute, read `GET /reviews/:routine/run-request`, and when a new `requested` one appears, start a run and say how that went ("Run requests" below). Without a poller, leave the Run button unused: a request nobody picks up shows "The runner didn't start the run" after 30 minutes.

With the CLI (`agent-inbox`, [cli.md](cli.md)), which reads the URL and token from its config or `AGENT_INBOX_URL`/`AGENT_INBOX_TOKEN`:

```bash
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
echo '{"model": "my-model", "log": "ci:/runs/'"$STAMP"'.log", "next_run_at": null}' > run.json
agent-inbox reviews start "$STAMP" --file run.json

# ... the review runs and writes report.json ...

jq -n --arg stamp "$STAMP" --slurpfile report report.json \
  '{stamp: $stamp, result: "ok", exit: 0, model: "my-model", report: $report[0]}' > payload.json
agent-inbox reviews report --file payload.json   # retry with this same file: a rebuilt one is a different body
```

The same with plain HTTP (the CLI's URL ends in `/agent`, so these paths are under `/agent/api`):

```bash
H=(-H "Authorization: Bearer $AGENT_INBOX_TOKEN" -H "Content-Type: application/json")
curl -fsS "${H[@]}" -d @run.json "$AGENT_INBOX_URL/api/reviews/runs/$STAMP/start"
curl -fsS "${H[@]}" -d @payload.json "$AGENT_INBOX_URL/api/reviews/report"
```

A poller's loop, one request at a time. It starts a run only once `started` is stored, so a failed update (another request replaced this one, the network) never starts a second run on the next poll:

```bash
set -euo pipefail
REQ=$(agent-inbox reviews request --json | jq -r '.request | select(.status == "requested") | .id')
if [ -n "$REQ" ]; then
  agent-inbox reviews request-update "$REQ" starting --message "waiting for a free worker"   # optional
  STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
  agent-inbox reviews request-update "$REQ" started --stamp "$STAMP"   # exits non-zero unless stored
  run_review "$STAMP"   # your run: start, review, report, as above
fi
```

## Who can do what

`routine` is always the writing token's manager id, stamped by the Worker. No body or path names it, so a routine's token can't write another routine. No new token scope: mint a manager token per routine (`orch-<routine>` with `--orchestrator <routine>`, and `orch-<routine>-dry` for dry runs, which go to their own routine id).

| Caller | Read | Write |
|---|---|---|
| Manager token (`orchestrator = R`) | routine `R` only (another routine is 403; `GET /reviews` lists only `R`) | routine `R`: start, report, and its run requests' updates |
| Orchestrator token | every routine of its own fleet | nothing (403) |
| Human, any role | every routine | deciders and admins: a run request (the Run button); admins only: `DELETE /reviews/:routine` |

A routine belongs to the fleet of the token that first wrote it ([api.md, "Fleets"](api.md#fleets)). A token of another fleet gets 403 on it, for reads and writes alike, and `GET /reviews` lists only its own fleet's routines.

## Endpoints

Paths are under `/api` and `/agent/api`, like every route.

| Method | Path | Body → response |
|---|---|---|
| POST | `/reviews/runs/:stamp/start` | `ReviewStartPayload` → `ReviewRun` (201 created, 200 already there) |
| POST | `/reviews/report` | `ReviewReportPayload` → `ReviewReportResponse` (201 stored, 200 replayed) |
| GET | `/reviews` | → `ReviewsResponse` |
| GET | `/reviews/:routine` | `?before=<stamp>&limit=<1-100>` → `RoutineReviewsResponse` |
| GET | `/reviews/:routine/prs/:n` | → `ReviewPrResponse` |
| GET | `/reviews/:routine/runs/:stamp` | → `ReviewRun` |
| DELETE | `/reviews/:routine` | → `ReviewDeleteResponse` |
| POST | `/reviews/:routine/run-request` | `{}` → `ReviewRunRequestResponse` (201; 409 while one waits or a run goes) |
| GET | `/reviews/:routine/run-request` | → `ReviewRunRequestResponse` |
| POST | `/reviews/run-requests/:id` | `ReviewRunRequestUpdate` → `ReviewRunRequestResponse` |

A **stamp** is the runner's UTC run stamp, `date -u +%Y-%m-%dT%H%M%SZ` (`2026-10-08T180000Z`). It has a fixed width, so string order is time order. Anything else is 400.

### `POST /reviews/runs/:stamp/start`

Best effort, sent when a run begins, so the tab can say "running since 14:00". Body `{started_at?, dry?, log?, model?, next_run_at?}`: `started_at` defaults to the stamp's time, `next_run_at` is the routine's next scheduled run (kept on the routine when given, and only from the newest run the routine knows, so a late or retried write of an older run never sets it back). Left out, the routine keeps the one it has; `null` clears it, for a routine that runs on demand only (no schedule), so the tab doesn't call a run overdue. The same goes for a report's `next_run_at`. It stores the run with `result: "running"`. A run that already exists comes back as stored, nothing written (200). That covers a retried start, and a start that arrives after its own report, which never turns a finished run back into a running one.

### `POST /reviews/report`

The run's outcome, sent once it ends, whatever the result:

```jsonc
{
  "stamp": "2026-10-08T180000Z",
  "started_at": "2026-10-08T18:00:00Z",       // optional, default: the stamp's time
  "finished_at": "2026-10-08T18:28:12Z",      // optional, default: now
  "result": "ok",                             // ok | failed | timed_out | report_invalid | seed
  "exit": 0, "error": null,
  "log": "runner:/var/log/reviews/2026-10-08T180000Z.log",  // optional: where the log is, shown as text
  "notify": "Approved 3 PRs; one call needs you",             // optional: a summary the runner sent elsewhere
  "model": "my-model", "dry": false,
  "next_run_at": "2026-10-08T20:00:00Z",
  "report": { "schema": 2, "headline": "...", "prs": [ ... ], "asks": [ ... ], "resolved": [ ... ] }
}
```

- `report` is required for `ok` and `seed`, must be `null` for `report_invalid`, and may be either for `failed` and `timed_out`. A run without a report still gets its run record ("a failed run still gets a run record"), and writes no PR state.
- Validation (`reportPayloadProblems`): every problem is checked before anything is written. A bad body is 400 `bad_request` naming the first problems, and nothing is stored. The runner then stores the run as `report_invalid`, with `report: null` and the message as `error`, so the run is never lost. The body's own text caps: `error` ≤ 8,000 characters, `notify` ≤ 2,000, `log` ≤ 1,000, `model` ≤ 100.
- Response `{run, prs_written, events_written, gone}`: the stored run, PR rows inserted or updated, events written, and PRs marked gone. 201.
- **Replays.** A run is finished once. Reporting a finished stamp again with the same body (same `report_sha`: SHA-256 of the body as canonical JSON, keys sorted) is a no-op that answers 200 with `replayed: true` and the stored run. A different body is 409 `conflict` with `current`: the stored run. The CLI exits 0 on a replay and 3 on the conflict.
- **The runner retries with the same file.** The hash covers the whole body, `finished_at` and `exit` included, not just the report. A retry must re-send the payload file it built the first time; rebuilding it (a new `finished_at`, say) makes it a different body and a 409. A start's `log` and `model` carry over to a report that leaves them out, and the start's `log` to that report's events.
- `seed` is a run that loads a report without reviewing anything (the initial import of today's PRs).

### Reads

- `GET /reviews` → `{routines: [{routine, version, last_run, next_run_at, counts, needs_you, running}]}`, sorted by id. `last_run` is the newest finished run (`{stamp, result, finished_at, headline}`, or null). `counts` maps status to current PRs, `needs_you` counts current PRs with `needs_you` set, and `running` is a run started after the newest finished one (`{stamp, started_at}`, or null). A routine whose runner died mid-run shows `running` until its next run finishes.
- `GET /reviews/:routine` → `{routine, prs, runs, more}`. `routine` is the head row (`ReviewRoutineHead`). `prs` holds every current PR, plus those gone in the last 7 days, newest number first. `runs` holds the newest `limit` runs (default 30, at most 100), newest first, with `?before=<stamp>` for the page before a stamp. `more` says an older page exists. 404 for a routine that has never written.
- `GET /reviews/:routine/prs/:n` → `{pr, events}`: the PR's row and its newest 50 events. 404 if the routine never tracked it.
- `GET /reviews/:routine/runs/:stamp` → the run. 404 if missing.

### Run requests

The routine card's **Run bot review** button asks the routine's runner for one run now, on a schedule or instead of one. The Worker never calls out to a runner, so the runner's poller comes to it: something on the runner's side (a cron job, a timer, a loop) reads the request with the routine's own token about once a minute. That read is one cheap GET, so polling costs nothing until a human asks. On a new request the poller starts a run and reports how that went, with the updates below. A request on a dry-run routine (an id ending in `-dry`) should start a dry run.

What a poller does with a request:

1. `GET /reviews/:routine/run-request`. Act only on `status: "requested"`; anything else is already handled (or is someone else's to finish).
2. Optionally say it's picked up (`starting`, with a `message` for what it waits on), when the run can't start right away.
3. If a run is already going, `skipped`. If it can't start one, `failed` with the reason in `message`.
4. Otherwise make the run's stamp, send `started` with it, then run as usual (start, review, report). The tab links the request to that run and shows how it ended.

The poller has 30 minutes (`RUN_REQUEST_STALE_MS`) from the request, or from its last `starting` update, to send `started`, `skipped` or `failed`. Past that the tab takes the poller to be down and lets a human ask again.

The request (`ReviewRunRequest`) lives on the routine's head row, one at a time: `{id, status, requested_at, requested_by, updated_at, stamp, message}`. `GET /reviews/:routine` carries it as `routine.run_request`.

- **Asking:** `POST /reviews/:routine/run-request`, body `{}`, by a decider or admin human only. No token can, not even the routine's own or the orchestrator's: an agent never spends a run on its own. 201 with the new request (`status: "requested"`). 404 for a routine that has never reported.
- **One run per click:** it's 409 `conflict`, with `current: {request}` and nothing written, while the newest request still waits on the poller (`requested` or `starting`, updated less than 30 minutes ago, `RUN_REQUEST_STALE_MS`) or while a run holds the routine (one `running` that started after its newest finished run, less than 4 hours ago, `RUN_STALE_MS`: a scheduled or hand-started run counts too). Past those windows the poller or the runner is taken to be dead, and a new request replaces the old one.
- **The poller's updates:** `POST /reviews/run-requests/:id` with the routine's own token, body `{status, stamp?, message?}` (`message` ≤ 500 characters):

  | Status | From | Means |
  |---|---|---|
  | `starting` | `requested` | Picked up; `message` says what it waits for (free memory, a lock, a worker) |
  | `started` | `requested`, `starting` | The run began; `stamp` (required, and only here) is its run stamp, so the tab links the run and shows how it ended |
  | `skipped` | `requested`, `starting` | A run was already going, and the tab says so instead of queueing it |
  | `failed` | `requested`, `starting`, `started` | It couldn't start one (the machine stayed short of memory, the request was picked up too late or left by a poll that died, or the run exited before the review began); `message` says why |

  A retry of the update already made (same status, and the same stamp for `started`) answers the request as stored, nothing written. Any other move is 409 with `current: {request}`, and an id that isn't the routine's newest request is 404 (another request replaced it). Another routine's token finds nothing (404); humans and the orchestrator token are 403.
- **Live:** each write bumps the head, so it logs the head's one change row (actor `human:<email>` for the ask, the token for an update) and the open tab refetches. `agent-inbox wait --human` doesn't wake on the ask ([cli.md](cli.md)).
- **The tab:** the button is held (disabled) while a request waits or a run goes, and the line beside it says how the newest request went: asked, picked up and waiting, running, finished (or failed) with a link to the run's page, skipped, or not picked up (the poller looks down). Viewers don't see it.

### `DELETE /reviews/:routine`

Admin humans only. Deletes the routine's runs, PRs, events and head row in one transaction, typically to clear a dry-run routine. 404 when there is nothing to delete. Nothing else references them: items the runner posted stay in the Inbox and History.

## CLI

The runner calls these with the routine's own token ([cli.md](cli.md)):

```bash
agent-inbox reviews start 2026-10-08T180000Z --file run.json     # best effort, before the run
agent-inbox reviews report --file payload.json                    # after it: exit 0 stored or replayed, 3 conflict, 1 refused
agent-inbox reviews show [--json]                                 # the token's routine: PRs and runs
agent-inbox reviews pr 4763 [--json]
agent-inbox reviews request [--json]                              # the routine's newest Run-button request
agent-inbox reviews request-update <id> started --stamp 2026-10-08T180000Z   # the poller: starting|started|skipped|failed [--message]
```

## The report

A run's report (`ReviewReport` in `shared/types.ts`, the authoritative shape) is one JSON object: a `headline`, optional `unverified` and `notes` lists (what the run couldn't check, anything else worth saying), optional `skipped` (reason → PR numbers the run left alone), and `prs`, every PR the routine tracks as of this run. A PR missing from the newest report has dropped out (merged, closed, no longer tracked): the tab moves it out of its group. One PR entry (`ReviewPr`), with only the required fields and a few common ones:

```jsonc
{
  "number": 812, "title": "Return 413 for oversized uploads", "url": "https://github.com/acme/widgets/pull/812",
  "author": "devon",
  "role": "reviewing",            // reviewing (someone else's PR) | mine (the human's own) | bot
  "status": "held_product",       // what it waits on, below
  "status_note": "Fail with 413, or truncate? A product call.",
  "needs_you": { "ask": "Should oversized uploads fail, or be truncated?" },   // or null
  "risk": "low",                  // low | medium | high
  "this_run": { "action": "commented", "url": "https://github.com/acme/widgets/pull/812#pullrequestreview-1",
                "summary": "Asked which behaviour we want.", "changes": [] },
  "ci": { "state": "passing" }, "mergeable": "clean"
}
```

`status` is one of: `held_product`, `held_owner`, `held_ci` and `awaiting_ok` (held: a product call, a code owner's area, CI, a drafted review waiting on the human's OK), `changes_requested`, `waiting_author`, `pending` (not reviewed yet), `approved` for someone else's PR; `mine_action`, `mine_waiting`, `mine_ready`, `mine_draft` for the human's own; `bot` for a bot's. `this_run.action` is what this run did on it: `approved`, `changes_requested`, `commented`, `replied`, `drafted` (left a review draft awaiting a human OK and posted nothing) or `none`. A PR with an action other than `none`, or with `this_run.changes` (what changed since the last run), gets an event on its timeline. The other optional fields (`impact`, `tradeoffs`, `risks`, `threads`, `reviewers`, `assignees`, `linear`, `links`, `last_action`, `base`, `created_at`, `updated_at`) are typed in `ReviewPr`; the PR page shows what it has.

The Worker stores each PR entry as is, unknown extra fields included. `reportProblems` refuses a report with:

- the top level not an object, `prs` not a list, more than 300 PRs, or two entries with the same `number`;
- on any PR: `number` not a positive integer; `title`, `url` or `author` not strings; `url` not `https` (it is the GitHub hook's match key); an unknown `role`, `status`, `risk` or `this_run.action` (`approved`, `changes_requested`, `commented`, `replied`, `drafted` or `none`; `drafted` means the run left a review draft awaiting a human OK and posted nothing); `this_run.changes` not a list; `needs_you` neither an object with an `ask` nor null;
- the list caps: `unverified` and `notes` ≤ 6, `tradeoffs` and `risks` ≤ 3, `this_run.changes` ≤ 4, `threads.items` ≤ 5, `links` ≤ 5, `needs_you.facts` ≤ 3, `needs_you.options` ≤ 4;
- a known field of the wrong type (strings, times, http(s) urls, `ci.state`, `mergeable` and reviewer states from their enums), or a PR entry over 16 KB as UTF-8 JSON;
- a short text field over 2,000 characters: `headline`, each `unverified` and `notes` entry, and on a PR `base`, `status_note`, `impact`, `this_run.summary`, `needs_you.ask`, `last_action.kind` and each entry of `this_run.changes`, `needs_you.facts`, `needs_you.options`, `tradeoffs` and `risks`. A PR's `title` and `author` have no cap of their own; the 16 KB entry cap bounds them;
- an unknown `schema`. A report without one is schema 1, as before.

A runner may check a report locally first, but this check decides: a report it passes can still be refused here. On that 400 the runner reports the run again as `report_invalid` (above).

### Schema 2: `asks` and `resolved`

Schema 2 adds two lists for the decision loop, both required with `schema: 2` (empty when there are none). A schema 1 report may carry them too, checked the same way. The Worker doesn't act on them: it keeps them in the run record, and the runner reconciles the Inbox.

- `asks`: the items this routine wants open now (`ReviewAsk`), at most 50. Each has a `key` of `<pr>-<hold>` equal to `review.pr` and `review.hold` (`product`, `owner`, `ci` or `post`), unique in the report, with `review.pr` one of the report's `prs`. `type` is `decision`, `proposal`, `blocker` or `info`, `title` is required (≤ 300 characters), and the optional fields are `priority`, `summary`, `question`, `context` (≤ 8,000 characters), `cost_of_waiting` and ≤ 5 `links`. `options` holds 2 to 4 `{id, label, consequence?, reversible?}` with unique ids, never `other` (every item offers it), and a `label` of ≤ 200 characters. `recommendation.option` must be one of them. The other text fields (`summary`, `question`, `cost_of_waiting`, an option's `consequence`, `recommendation.why`) are ≤ 2,000 characters.
- `review` also takes `hold_review_id` (the held draft's id, optional: a `post` ask has no hold review) and, for a `post` ask (`<pr>-post`, a drafted review waiting on a human OK before it posts), the optional `pending_review_id` (positive integer, the draft's REST id; null in a dry run, which creates no draft) or, when the routine keeps its drafts itself rather than as a pending review on GitHub, `draft_id` (its own id for the draft, 1-100 characters with no spaces; never both), `event` (`APPROVE`, `COMMENT` or `REQUEST_CHANGES`) and `head_sha` (the head the draft was written against, a non-empty string). Their absence is not an error: the Worker only stores the ask. A PR whose draft waits on that OK reports status `awaiting_ok`, which the tab groups with the `held_*` statuses.
- `resolved`: the items this run acted on (`{id, version, pr, review_url?}`), at most 100, each id once. `version` is the version the run read; the runner archives each item pinned on it.
- A product ask may also carry `review.also`: the other PRs the same call covers (each in `prs`, distinct, not `review.pr`, at most 5). It's one ask for all of them: the runner gives the item `review_pr.also`, the tab shows it as the ask on each of those PRs ("Decide in Inbox" and a chip per PR on the item), and the run carries the decision out on every one. Only the primary PR goes in the item's `links`, so the GitHub hook doesn't close the ask when one of the others merges. `also` on any other hold is refused.
- `answers` (optional, any schema): answers to questions asked on the routine's items (`{id, text}`, at most 50, each id once, text 1–8,000 characters). The runner posts each to that item's Q&A thread as the routine (role `orchestrator`), which clears `qa_pending`.
- An ask's human may answer "Done on GitHub" (`decision.choice == "github"`, [api.md](api.md) decide): they handled it on GitHub, and the routine posts nothing for it.

### Posting asks as items

The runner, not the Worker, turns `asks`, `resolved` and `answers` into Inbox writes, with the routine's token ([api.md](api.md) Items):

- **An ask** becomes item `<routine>-<key>` (`review-bot-812-product`), posted with `PUT /items/:id` and `if_version: 0` when it doesn't exist yet. A routine's token can't reopen an item once it's decided or archived, so when the same hold comes back after its item closed, post the next free id with a numeric suffix (`review-bot-812-product-2`, then `-3`). Give it the ask's fields (`type`, `title`, `question`, `options`, `recommendation`, ...) plus `orchestrator` and `source` set to the routine id, `review_pr: {routine, number}` (and `also` for a shared product call), the PR in `links`, and `close_on_pr: true` so the GitHub hook closes it when the PR merges or closes. The tab finds a PR's ask by `review_pr` (or, failing that, by the id pattern) on an item whose `orchestrator` is the routine.
- **A resolved item** (the run acted on the human's decision) is archived with `POST /items/:id/archive` and `if_version` set to the run's `version`, so a decision changed since the run read it stays open.
- **An ask that's gone** from the newest report while its item is still `open` (the hold cleared another way) is withdrawn with `POST /items/:id/withdraw` and its version, with a `note` saying why.
- **An answer** is posted with `POST /items/:id/qa`, role `orchestrator`.

## GitHub hook

Between runs, `POST /hooks/github` ([api.md](api.md#post-hooksgithub), `worker/hooks/github.ts`) keeps each tracked PR's GitHub facts fresh. It needs a webhook on the PRs' repo with **Pull requests** and **Pull request reviews** ticked, signed with the same `GITHUB_WEBHOOK_SECRET` as the items hook ([deploy.md](deploy.md#github-webhook)). There is no `check_suite` or `check_run`: CI is high-volume chatter, and each run reports CI anyway.

| Delivery | Into `gh` |
|---|---|
| `pull_request` `synchronize` (new commits) | `head_sha` (`pull_request.head.sha`) and `pushed_at` (`pull_request.updated_at`). An older push delivered late doesn't replace a newer one. GitHub's times are in seconds, so a push in the same second with a new sha does replace it. `gh.push_deliveries` keeps the last 20 applied delivery ids, and `gh.push_shas` every sha pushed in `pushed_at`'s second. A redelivered push (the same id), or one in that second with a sha already pushed in it (whatever its id), changes nothing: after A, B in one second, a late A never takes the head back |
| `pull_request` `converted_to_draft` / `ready_for_review` | `state: "draft"` / `"open"` |
| `pull_request` `reopened` | `state: "open"` (`"draft"` for a draft PR), and clears `gone_at` |
| `pull_request` `closed` | `state: "merged"` or `"closed"`, and sets `gone_at` when it isn't set |
| `pull_request_review` `submitted` (approved, changes requested or commented) | appends `{login, state, at}` to `reviews` (state lowercased, `at` the review's `submitted_at`), keeping the newest 30. A redelivered review isn't added twice |

- **Every routine's row.** A delivery looks the PR up by `url` (`review_prs_url`) across routines, so a PR tracked by `review-bot` and `review-bot-dry` updates both.
- **`gh` only.** The hook never writes `data`, `status` or `last_stamp`: only a run writes those, and a run never writes `gh`.
- **State deliveries in order.** The state deliveries are closed, reopened, converted_to_draft and ready_for_review. Each carries its `pull_request.updated_at`. `gh.state_at` keeps the newest one applied, and `gh.state_deliveries` keeps the last 20 applied `X-GitHub-Delivery` ids. A state delivery older than `state_at` changes nothing, and neither does a redelivery, which repeats its id. A newer one moves `state_at` even when it leaves the state as it is: after close (t1) and close (t3), a reopen (t2) delivered late stays out. That write logs a change row like any other. So after close → reopen → close, a redelivered reopen leaves the PR closed, and an earlier close replayed after a reopen leaves it open. One watermark covers every state: a draft or ready delivery newer than a close revives the PR, since GitHub can't draft a closed PR, so its reopen came in between and is still on its way. Close (t1) → reopen (t2) → draft (t3), delivered t1, t3, t2, ends as a draft. A merge always lands.
- **One batch, one change row per routine.** Per routine, one `UPDATE` writes all of its rows or none. It writes only while every row still has the `url`, `gh` and `gone_at` it read. Then comes the routine's head bump, which lands only if that `UPDATE` changed a row. The routine gets one change row (actor `hook:github`), and the open tab refetches through the delta's `reviews_changed`. If a report rewrote a row in between, the hook reads that routine's rows again, up to 3 times. A routine already written isn't written again in the same delivery, so it never logs twice, even when several of its PR entries share the url.
- **Terminal states** follow items' `pr_state` rule (`advances()`). Once merged, a row takes nothing more: no reopen, draft, push or review. Once closed, it takes only a merge, a reopen, or a draft or ready delivery newer than the close (see above); either brings it back into the current PRs. Reviews and pushes on a closed PR are dropped, as items drop late reviews.
- **No-ops log nothing.** A delivery that changes no row (an unknown PR, a replay, a terminal row) writes nothing and bumps no head. The response lists each changed routine as `{collection: "reviews", id: <routine>}` in `updated`, next to the items and managers.
- **The next run decides.** A newer report still un-gones a PR it lists, and marks gone a PR it no longer lists, whatever `gh` says.

How the tab shows them:

- **Reviews.** Each one is a timeline entry in the PR pane: "sam approved" or "kim changes requested" at the review's time. It sits under Author when the reviewer is the PR's author, and under All otherwise.
- **Pushes.** The newest push is a "Pushed · New commits since the last run" entry at `pushed_at`, under Author.
- **Merged or closed.** The PR leaves the list's groups (`gone_at`), and its page says it dropped out of the newest report. A reopen puts it back in its group, with the last run's status until the next run.
- **Not shown yet.** `gh.state` `draft`/`open` and `head_sha` are stored for later, but nothing displays them.

## Storage

Migration `0009_reviews.sql`: four tables, no new columns or triggers on existing ones. Migration `0011_review_run_request.sql` adds `review_routines.run_request`, the newest run request as JSON ("Run requests" above).

| Table | Key | Holds |
|---|---|---|
| `review_routines` | `routine` | The head: `version`, `last_stamp` (newest finished run), `next_run_at`, `updated_at`/`updated_by`, `run_request`. Every write bumps it |
| `review_runs` | `(routine, stamp)` | `started_at`, `finished_at` (null while running), `result`, `dry`, `has_report`, `report_sha`, `data` (the run record) |
| `review_prs` | `(routine, number)` | The PR's current state: `url` (trailing slashes trimmed; indexed for the hook), `role`, `status`, `needs_you`, `data` (the report's entry), `last_stamp` (the run that wrote it), `gh` (between-run facts from the GitHub hook, "GitHub hook" above), `gone_at` |
| `review_events` | `(routine, number, stamp)` | One per PR per run whose `this_run.action` isn't `none` or whose `this_run.changes` isn't empty |

### The run record

The run record (`ReviewRunRecord`) is built by the Worker from the report payload and its report: `stamp`, `started`, `finished`, `dry`, `result`, `exit`, `error`, `log`, `model`, `headline`, `notify`, `schema`, `counts` (by status), `actions` (each PR with an action), `needs_you` (`{pr, title, ask}`), `unverified`, `notes`, `skipped`, plus `asks` and `resolved`. An event (`ReviewEvent`) is one PR's line of that run (`pr`, `stamp`, `at`, `title`, `url`, `role`, `action`, `review_url`, `summary`, `changes`, `status`, `status_note`, `log`).

### Indexes

Every read is per routine and seeks a primary key: `(routine, stamp)` for runs (newest first, paging by `before`), `(routine, number)` for PRs and `(routine, number, stamp)` for a PR's events. A routine holds about 45 current PRs and 30 days of gone ones, so its status counts and the cron's prunes scan a few hundred rows. The one secondary index is `review_prs (url)`, for the GitHub hook: it is not scoped by routine, because a PR can be tracked by several routines at once (`review-bot` and `review-bot-dry`), and the hook must update every routine's row for the url (bumping each routine's head) rather than assume one.

### Write semantics

A report is one `db.batch` (one transaction), the same five statements however many PRs it carries. Each statement does nothing once the run is finished, so a replay or a conflict writes nothing at all:

1. Upsert the head: bump `version`, raise `last_stamp` to this stamp if it is newer, take `next_run_at` when given (`null` clears it) and this is the newest run the routine knows.
2. Upsert every PR from the report (`json_each` over one bound array).
3. Mark gone the current PRs that this report no longer lists.
4. Insert the events.
5. Upsert the run (insert it, or finish the `running` row).

Statements 2 to 4 run only for a report, and they move PR state only forward. **The newest report decides.** A PR row changes only when the report is newer than the run that last wrote that row. A report older than the routine's newest stored report (a late retry) clears no `gone_at`, marks nothing gone, and inserts the PRs it alone lists as already gone. A PR that the newest report dropped never comes back from an older one.

A start is one batch of two statements (head, run), each conditional on the run not being finished, behind the fleet guard (below).

### Change log

Only the head row logs: triggers on `review_routines` append exactly one `changes` row per write, with collection `reviews`, doc id the routine, `orchestrator` the routine, and actor the writer (`token:<name>`, `hook:github` for the GitHub hook; `''` for the admin delete, as for every delete). A 45-PR report is one change row, so review data doesn't eat into the delta's 500-change window. The routine's own token sees its rows in `/api/changes` (filtered on `orchestrator`), and the orchestrator's `wait --human` never wakes on them (not `human:`). Replays, refusals and the cron's pruning log nothing.

- `/api/changes?collection=reviews` filters to them.
- `/api/state` adds `routines: [{id, version, last_run_at, result}]`: every routine with a head row (a manager token: only its own), `last_run_at` and `result` from the newest finished run. The UI shows the Reviews tab only when it is non-empty.
- `/api/state/delta` adds `reviews_changed: [routine ids]` and the whole `routines` list whenever a routine's head changed. A client replaces `routines`, and refetches `GET /reviews/:routine` if it is showing that routine (else marks it stale).

### Limits

- `POST /reviews/report` reads bodies up to 1 MiB. Every other route keeps 256 KiB. The real 45-PR report is 136 KB.
- One report is the same handful of D1 statements whatever its size: the token lookup, then one batch: a guard that fails it when the routine belongs to another fleet (403, [api.md, "Fleets"](api.md#fleets)), and the five writes (`test/worker/reviews-writes.test.ts` asserts the count is the same for 3 and 45 PRs).

### Retention

The daily cron (`pruneReviews` in `worker/prune.ts`) deletes:

- runs and events older than `REVIEWS_RETENTION_DAYS` (default 90, at least 14; anything else fails the cron run, like `CHANGES_RETENTION_DAYS`), always keeping three runs per routine: its newest, its `last_stamp` run (so `/api/state` never changes under a client) and its newest run with a report (the watermark that keeps a late older report from bringing back a PR the newest report dropped);
- PRs gone for more than 30 days.

It logs no change rows: nothing it deletes is in `/api/state`, and the tab hides gone PRs after 7 days and loads runs a page at a time. Size: about 45 PR rows × 3 KB, plus about 4 runs a day × 5 KB and their events, a few MB per 90 days.
