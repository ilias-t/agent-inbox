# agent-inbox CLI reference

`agent-inbox` (`bin/agent-inbox.mjs`) is a zero-dependency Node ≥ 22 CLI. Recipes: [orchestrator.md](orchestrator.md) for the orchestrator, [manager.md](manager.md) for managers. Token scopes and doc ids keep their original names: scope `manager` and `meta/manager` belong to the orchestrator; scope `orchestrator`, the `orchestrator` field and `orchestrators/<ID>` belong to managers. The HTTP API behind it: [api.md](api.md).

## Install and configure

```bash
npm link            # from your checkout: puts agent-inbox on PATH
```

Configuration, highest first:

| Source | URL | Token |
|---|---|---|
| Flags | `--url` | `--token` |
| Environment | `AGENT_INBOX_URL` | `AGENT_INBOX_TOKEN` |
| Config file: `$AGENT_INBOX_CONFIG`, else `$XDG_CONFIG_HOME/agent-inbox/config.json`, else `~/.config/agent-inbox/config.json` | `"url"` | `"token"` |

**Lease session (orchestrators, opt-in).** `--session <id>` (a global flag, accepted before or after the command) or `AGENT_INBOX_SESSION` names your lease session. The lease commands use it as `session_id`, as before. Every other write (`post`, `patch`, `claim`, `archive`, `withdraw`, `delete`, `answer`, `decide`, `orch set`/`delete`, `meta set`, `tick-request`, `digest`, `schedule set`, `batch`) then also sends it as the `X-Lease-Session` header, and the server refuses the write with exit 3 `lease_held` (the lease as `current` on stderr) once that session no longer holds a fresh lease ([api.md](api.md) "Lease-checked writes"). Reads never send it. Without either, writes behave as before. A flag or variable that is present but empty (`--session "$S"` with `S` unset, `AGENT_INBOX_SESSION=`) is a usage error (exit 2) on every command, so a write can't go out unchecked by accident. `CLAUDE_SESSION_ID`, which the lease commands fall back to, never turns the check on: every Claude Code session has it, and it needn't be the lease's session id. Manager tokens are never checked, so the header is a no-op for them.

The URL is the deployment's `PUBLIC_URL` plus the `/agent` prefix, `https://<your-host>/agent` (default `http://localhost:8787/agent`). Keep the orchestrator's token in the config file (mode 600), not in a shell profile: managers on the same box then use their own file through `AGENT_INBOX_CONFIG`, and a global `AGENT_INBOX_TOKEN` would override it. A set but empty `AGENT_INBOX_TOKEN=` overrides it too: it means no token (the local dev human on a plain localhost URL), not the file's.

## Tokens and scopes

Mint tokens in the UI (**Settings → Agent tokens**, admins only) or with the script (needs wrangler credentials for `--remote`):

```bash
node scripts/create-token.mjs --name manager --scope manager --remote
node scripts/create-token.mjs --name orch-O3 --scope orchestrator --orchestrator O3 --remote
```

The token (`ait_<id>_<secret>`) is printed once; D1 keeps only the SHA-256 of the secret. A live token's name must be unique (the change log records writers as `token:<name>`). Revoke from the UI.

Each token belongs to one fleet ([api.md](api.md) "Fleets"), the default fleet unless you pick another: a registered fleet (Settings → Fleets) in the token form, or `--fleet <id>` on the script (`--create-fleet` also registers it, for a deployment without the UI). A manager token belongs to the fleet that owns its manager id, so leave the fleet out for it; naming another one is refused. `agent-inbox me` prints the token's fleet.

| Token | Can |
|---|---|
| `manager` | Every item, qa, manager, meta, lease, schedule and change-feed operation, including decide. Not: tokens, roles (`PUT`/`DELETE /api/users`), snoozing, Web Push or `/api/people/me`, which are humans' |
| `orchestrator` for `O3` | Its own items (`orchestrator == "O3"`), their qa, `orchestrators/O3`, the schedule, its own changes and its own review routine `O3` (`reviews start`/`report`/`request-update`, [reviews.md](reviews.md)). Creates items `open` and never changes their status, writes `decision` only when creating an `auto_decided` item, answers qa as `orchestrator`, can archive its own `decided` item and withdraw its own `open` one, each posted with `source: "O3"` (pinned). Everything else is 403 |

Tokens have no role; humans' roles (admin, decider, viewer) are set by an admin in Settings → People, and `agent-inbox users` lists them. The full matrix is in [api.md](api.md) "Endpoint index".

Name manager tokens `orch-<ID>` so `agent-inbox wait --actor token:orch-` can pick out their writes. Scopes stop mistakes, not a hostile process: every session on the box runs as the same Unix user and could read the orchestrator's config file.

## Commands

`agent-inbox help` lists them and `agent-inbox <command> --help` shows flags. `--json` prints the raw API response (agents should use it).

| Command | Does |
|---|---|
| `me [--expect-fleet <id>]`, `state [--fleet <id>]` | Who the token is (a human's role, a token's fleet); everything the UI loads. `--expect-fleet` exits 3 (and says why on stderr) unless the token belongs to that fleet (`default` for the default fleet): an orchestrator's startup check that it was given the right token. A person is in no fleet, so it exits 3 for them too. `state --fleet` keeps one fleet's items and managers, with its own status, lease and hours |
| `fleets` | Each fleet you can see, with its orchestrator's status: lease holder and heartbeat, last and next tick, work hours (and whether they're inherited). People see every fleet; a token, its own |
| `users` | People and their roles (`email  role  name`). Read-only: roles are set by an admin in Settings → People, and no token can change them |
| `items [--status open,decided] [--orchestrator O3] [--qa-pending] [--type T] [--assignee email\|none\|me] [--fleet <id>]` | List items (`me` = your email from `/api/me`; humans only) |
| `show <id>`, `qa <id>` | Item with its qa thread; the thread alone |
| `post <id> [--file item.json\|-] [--type --title --summary --question --context --priority --orchestrator --assignee --source --cost-of-waiting --option id:label[:desc]… --recommend opt[:conf[:why]] --link label=url… --evidence label=url… --decision choice[:note] --set k=v…]` | Create an item (`if_version: 0`); `--if-version N` replaces version N. On a decided or processing item, a replace that changes its status or decision exits 3 `decided` (who decided, when, the choice) unless `--replace-decided` |
| `patch <id> --set k=v… \| --set k:=json… \| --unset k… \| --file patch.json [--assign email\|me \| --unassign] [--if-version N] [--replace-decided]` | Merge fields (`k:=null` or `--unset k` deletes); `--assign`/`--unassign` set or clear `assignee`. `--replace-decided`: as on `post` |
| `decide <id> <choice> [--note] [--if-version N \| --no-pin]`, `ask <id> <text>` | Act as the human (testing; `ask` needs a human principal). `decide` is always pinned, like the page and the ntfy buttons: it reads the item first and decides only that version, so a change in between, or an item no longer open, exits 3 (`conflict` / `not_open`, with `current` on stderr) and decides nothing. `--if-version N` pins on N instead and skips the read; `--no-pin` decides whatever is current (the behaviour before pinning) |
| `claim <id> [--if-version N]`, `archive <id> [--if-version N]`, `delete <id> [--if-version N]` | Orchestrator status moves. A manager token can `archive` its own `decided` item posted with `--source <its id>`, with `--if-version` ([api.md](api.md) "Archiving your own item") |
| `withdraw <id> --if-version N [--note text]` | Take back an `open` item whose question no longer applies: it is archived with `decision.choice: "withdrawn"` and the note as the reason (History shows "Withdrawn"). `--if-version` is the version you read as open (required). A manager token withdraws only its own item posted with `--source <its id>` (403 otherwise); the orchestrator and admins any open item. Exit 3 when the item changed or is no longer open, e.g. the human decided it first (`conflict` / `not_open`, `current` on stderr): read `current` and act on the decision ([api.md](api.md) "Withdrawing your own item") |
| `answer <id> <text\|-> [--if-version N] [--set k=v…] [--file data.json]` | Answer qa; clears `qa_pending` and applies `--set` / `--file` to the item in the same write |
| `orch list`, `orch show <id>`, `orch set <id> --file\|--set…\|--unset k… [--if-version N]`, `orch delete <id> [--if-version N]` | Manager docs (`--file` = PUT, `--set`/`--unset` alone = PATCH, created if missing) |
| `orch relink (<id> [--session-id <uuid>] \| --all) [--seed]` | Point a manager doc's `session_url` at its running Claude Code session (`--all`: every manager that isn't done). A manager whose session isn't running keeps its link and gets `session_live: false`. `--session-id` records the Claude session uuid on the doc first; `--seed` fills a missing `session_id` from the transcripts. It reads this machine's Claude Code files ("Session files" below); recipe in [orchestrator.md](orchestrator.md) |
| `meta get <id>`, `meta set <id> --file\|--set…\|--unset k… [--if-version N]`, `tick-request [--note]` | Meta docs (`manager`, `lease`, `schedule`; `set` like `orch set`) and the Run tick now request |
| `batch --file ops.json\|-` | Several writes in one transaction, all or none: `{"ops": [...]}` or a bare array, ops as in [api.md](api.md) "Batch" (`{"op": "item.claim", "id": "x", "if_version": 4}`). Prints one line per op; exit 3 on any 409 (a failed pin, `not_decided`), with the failing op's `index` in the stderr JSON |
| `digest [<markdown\|->] [--sweep] [--next-tick ISO\|+10m] [--if-version N]` | Stamps `meta/manager.last_pickup` (and `last_tick` with `--sweep`) and `next_tick` (default: the schedule's next pickup); writes the digest only when given |
| `lease [get]`, `lease acquire --session S [--title] [--holder-url] [--ttl MIN] [--force --if-version N]`, `lease renew --session S [--ttl MIN] [--if-version N]`, `lease release --session S` | Orchestrator lease (`--session` defaults to `$AGENT_INBOX_SESSION`, then `$CLAUDE_SESSION_ID`; TTL defaults server-side to max(25, pickup + 15) min). `--session` on any other write turns on the lease check (above) |
| `schedule [show] [--cron \| --check]`, `schedule set [--work-hours "10:00-18:00 Mon-Fri"] [--timezone Z] [--pickup 10] [--sweep 30] [--if-version N] [--force]` | Schedule, next pickup and the UTC cron expression(s); `--check` exits 0 in hours, 5 off hours. `set` exits 2 when the stored schedule doesn't validate (the server shows defaults); `--force` writes the defaults plus your flags over it |
| `changes [--since N] [--wait 0-25] [--collection C] [--fleet <id>]` | One read of the change feed (`C`: `items`, `orchestrators`, `meta`, `qa`, `reviews`) |
| `reviews start <stamp> [--file run.json\|-]` | A review routine's runner marks a run started (`{started_at?, dry?, log?, model?, next_run_at?}`), so the Reviews tab shows it running. A run that already exists is printed as stored, nothing written. The routine is the token's manager id ([reviews.md](reviews.md)) |
| `reviews report --file payload.json\|-` | Stores a finished run and its report (`{stamp, result, report, ...}`, [reviews.md](reviews.md)). Exit 0 when stored, and on a replay of the same body (`replayed: true`); 3 when that run is already stored with a different body (the stored run on stderr); 1 when the server refuses the report (the message names the problems) |
| `reviews [show] [<routine>] [--limit N] [--before STAMP]`, `reviews pr <n> [--routine R]` | A routine's PRs and runs (default: the token's own routine; a token without one, or a human, lists every routine), and one PR with its events |
| `reviews request [<routine>]` | The routine's newest Run-button request (default: the token's own routine), or `no run request` ([reviews.md](reviews.md#run-requests)). No command makes one: only a human in the browser can |
| `reviews request-update <id> starting\|started\|skipped\|failed [--stamp STAMP] [--message TEXT]` | The routine's poller reports how a request went: picked up, started (with the run's stamp), skipped (a run was already going) or failed. A retry of the update already made prints the request as stored; any other move exits 3 with it on stderr; 1 (404) when another request replaced it |
| `wait [--since N \| --cursor-file F] [--human] [--actor prefix…] [--collection C] [--status S] [--id ID…] [--op OPS] [--fleet <id>] [--timeout 600]` | Block until a matching change, print it and the new cursor |

**Fleets.** A token belongs to one fleet ([api.md](api.md) "Fleets") and sees only that fleet, so the CLI needs no fleet flag for it: its lease, status, hours and items are its own fleet's. `--fleet <id>` (`default` for the default fleet) on `items`, `changes`, `wait` and `state` filters for callers who see every fleet: people, on a local URL without a token. A token that names another fleet there gets exit 1 instead of a filter the server would ignore, and so does a person naming a fleet the server doesn't have (a server from before fleets would ignore the filter). A manager token's `fleets` says the lease and status aren't visible to it rather than showing them empty. Against a server from before fleets, every token is the default fleet's, so `me --expect-fleet <named fleet>` exits 3 until the server is upgraded. A fleet without hours of its own shows the deployment's as `[inherited …]` in `schedule`; `schedule set`, or `meta set schedule --set k=v`, gives it its own, starting from the hours it inherits.

## Values

`--set key=value` is a string, `key:=<json>` is typed (`qa_pending:=false`). A trailing `<text>` may be unquoted words; `-` reads stdin.

`me` in `--assignee`/`--assign` is the caller's email from `/api/me`, so it needs a human principal (local dev without a token); with a token it's a usage error (exit 2). Listings show an assigned item as `[@<email>]`, and `show` prints `Assignee:`; items without one print as before.

## Session files

`orch relink` runs on the machine where the managers' Claude Code sessions run. It finds each running session in Claude Code's `<pid>.json` session files and, for `--seed`, searches the `<sessionId>.jsonl` transcripts. Two variables replace the default locations; each takes a `:`-separated list of directories, and a set variable replaces the default rather than adding to it:

| Variable | Default | Holds |
|---|---|---|
| `AGENT_INBOX_SESSION_DIRS` | `~/.claude/sessions` | `<pid>.json` for each running session (its `sessionId` and Remote Control `bridgeSessionId`) |
| `AGENT_INBOX_PROJECT_DIRS` | `~/.claude/projects` | `<cwd-slug>/<sessionId>.jsonl` transcripts |

Sessions started with another `CLAUDE_CONFIG_DIR` (a second account, say) keep their files under that directory, so list every one in use: `AGENT_INBOX_SESSION_DIRS=$HOME/.claude/sessions:$HOME/.claude-work/sessions`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | error (network, 4xx, 5xx) |
| `2` | usage |
| `3` | `me --expect-fleet` on another fleet's token; conflict: any 409 (`conflict`, `not_open`, `not_decided`, `lease_held`), with `{error, message, current}` as JSON on stderr (`batch` adds `index`: the op that failed; nothing was written). `lease_held` on a write that isn't a lease command means `--session`/`AGENT_INBOX_SESSION` no longer holds the lease; it has no `index` on a batch |
| `4` | `wait` timed out (stdout still has the cursor) |
| `5` | `schedule --check` outside work hours |

## Wake path

Every write lands in the change log. `agent-inbox wait --human` long-polls `/agent/api/changes` (25 s per request) and exits as soon as a change made by a human arrives: a decision, a question, an override, a reassign, a tick request, a schedule or People edit, or an ntfy button tap (`hook:ntfy`). Snoozes never wake it: they are one person's own and tokens never see them. Nor does a Run-button click on the Reviews tab (a human's change on collection `reviews`): it's for the review routine's poller ([reviews.md](reviews.md#run-requests)); `--actor human:` still matches it. Network errors and 5xx retry with backoff up to 30 s; nothing busy-loops. `--cursor-file` makes it resumable across runs; `--actor token:orch-` adds managers' own writes.

```bash
# One notification per human action (Claude Code Monitor, re-armed on expiry):
while true; do
  agent-inbox wait --human --cursor-file ~/.cache/agent-inbox/manager.cursor --timeout 0 \
    || { echo "inbox wait failed (exit $?), retrying in 60s"; sleep 60; }
done
```
