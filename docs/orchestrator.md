# Orchestrator recipe: the orchestration-manager skill on agent-inbox

The command for every inbox operation in the `orchestration-manager` skill ([`skills/orchestration-manager/`](../skills/orchestration-manager/SKILL.md): `SKILL.md`, `references/inbox.md`). The data model, statuses, briefing fields and lease rules stay as the skill describes them; only the transport changes from `ArtifactData` calls to `agent-inbox` commands. Always pass `--json` and parse the result.

## Setup (once per box)

```bash
cd ~/dev/agent-inbox && npm link
mkdir -p ~/.config/agent-inbox && chmod 700 ~/.config/agent-inbox
cat > ~/.config/agent-inbox/config.json <<'EOF'
{"url": "https://<your-host>/agent", "token": "ait_<orchestrator token>"}
EOF
chmod 600 ~/.config/agent-inbox/config.json
agent-inbox me          # token manager (manager) fleet default
```

`https://<your-host>` is the deployment's `PUBLIC_URL` in `wrangler.jsonc` (`vars.PUBLIC_URL`); the agent URL is that plus `/agent`. An orchestrator that is already set up has it as `url` in `~/.config/agent-inbox/config.json`: read it from there rather than guessing.

In the registry's Orchestrator state, replace `inbox_url` with the page URL `https://<your-host>/` (`PUBLIC_URL` plus `/`; item links are `#item.<id>`, manager briefings `#orch.<id>`). There is no page to republish.

Lease commands need your `holder_session_id`. Shell variables don't persist between Bash calls, so pass `--session <id>` each time (or prefix `AGENT_INBOX_SESSION=<id>`).

**Shell gotchas** (from a live session, 2026-10-14):
- The Bash tool's shell may be zsh, where `A="node …/agent-inbox.mjs"; $A items` doesn't word-split. Wrap multi-command calls in `bash -c '…'`, or call the binary by its full path each time.
- An apostrophe in item text breaks a heredoc inside `bash -c '…'`. Write item and batch JSON to a file with the Write tool and pass `--file`.
- Never put `rm` inside a `bash -c` script. Claude Code's removal safety check can't inspect it and blocks the whole command, so the inbox write in it never runs. Delete temp files in a separate plain `rm <path>` call. The bare word `rm` anywhere in the script trips the check too, even inside a quoted string. Python and text edits go in a script file written with the Write tool.
- `items --json` returns `{"items": [...]}`; `claim`, `archive` and `post` return the doc itself (`{id, version, data}`).
- **A decided item is the user's.** `post --if-version N` (a replace) or `patch` on a `decided` or `processing` item exits 3 `decided` when it would change the item's status or decision, and the stderr message says who decided it, when and what they chose. Read it and act on it (claim, relay, archive); never repost over it. `--replace-decided` overrides, only when the user asked for the item to be reset.

**Lease-checked writes (recommended).** Give your writes the same session too: prefix each write command with `AGENT_INBOX_SESSION=$S` (or add `--session $S`), e.g. `AGENT_INBOX_SESSION=$S agent-inbox claim <id> --if-version N --json`. The server then refuses any write once `$S` no longer holds a fresh lease, so a session that lost a takeover can't claim, relay or archive alongside the new holder. Such a refusal is exit 3 with `{"error":"lease_held","current":{...the lease}}` on stderr: treat it exactly like a `lease_held` from `lease renew` (step down, below). An expired lease of your own is refused too, so renew first (every tick and wake already does). Without the prefix, writes behave as before. Reads don't need it.

## Operation map

`$S` is your `holder_session_id`. `N` is the `version` from your last read of that doc.

| Skill step (artifact) | agent-inbox |
|---|---|
| Startup: read `meta/lease` | `agent-inbox lease --json` → `{lease, expired, now}` |
| Claim a missing or expired lease | `agent-inbox lease acquire --session $S --title "<session title>" --holder-url https://claude.ai/code/cse_<id> --json` |
| Lease held by another fresh session | `acquire` exits 3 with `{"error":"lease_held","current":{...}}` on stderr → ask the user (Take over / Observer) |
| Take over (force-claim with the version you read) | `agent-inbox lease acquire --session $S --force --if-version <current.version> --json` |
| Every tick: renew first | `agent-inbox lease renew --session $S --json` without `--ttl`: the server sets the TTL to max(25, pickup interval + 15) minutes so the lease outlives the gap between pickups. Exit 3 `lease_held` → you lost it: stop the ticker (TaskStop) and the heartbeat (`pkill -f '[h]eartbeat.sh <session_id>'`, which matches yours wherever the state directory is; it also exits on its own next `lease_held`), delete any CronCreate job, say so, stop |
| Step down cleanly | `agent-inbox lease release --session $S` |
| Query `items` where `status == decided` | `agent-inbox items --status decided --json` |
| Which items are yours | Items whose `orchestrator` is in your registry, or with no `orchestrator` and a `source` you write (`manager`, `scout:*`, `sweep:*`) or no `source` (older items). Filter `items --status decided` and `items --qa-pending` client-side; leave other agents' items alone |
| Claim before acting (`status: processing`, pinned) | `AGENT_INBOX_SESSION=$S agent-inbox claim <id> --if-version N --json`; exit 3 (`not_decided` or `conflict`) → the stderr `current` says what changed; skip it unless it is still `decided`. Exit 3 `lease_held` → you lost the lease: step down as on renew |
| Re-take an item another session left `processing` | `agent-inbox items --status processing --json`, keep yours whose `claimed_by` isn't `$S`, then the same `AGENT_INBOX_SESSION=$S agent-inbox claim <id> --if-version N --json`. The doc comes back with `claimed_by: $S` and `reclaimed_from` (the old session, or `null`). Check whether the old session already acted before acting (SKILL.md Tick step 2). Exit 3 `not_decided` on one of your own (`claimed_by` is `$S`): you parked it, leave it |
| Archive after acting | `AGENT_INBOX_SESSION=$S agent-inbox archive <id> --json` |
| Query `items` where `qa_pending == true` | `agent-inbox items --qa-pending --json` |
| List `items/<id>/qa` | `agent-inbox qa <id> --json` (or `show <id> --json` for item + thread) |
| Answer: qa doc + pinned item update `{qa_pending: false, qa_answered_at}` | `AGENT_INBOX_SESSION=$S agent-inbox answer <id> - --if-version N --json <<'EOF'` … `EOF` — one atomic write; no message is stored if the pin fails (exit 3) |
| Answer that changes the briefing | add `--set recommendation:='{"option":"b","confidence":"high","why":"..."}'` (or `--file data.json`) to `answer` |
| New item (proposal, decision, blocker, pr_ready, info) | `AGENT_INBOX_SESSION=$S agent-inbox post <id> --file item.json --json` (exit 3 if the id exists) or flags, see below |
| `auto_decided` item | `AGENT_INBOX_SESSION=$S agent-inbox post <id> --type auto_decided --title ... --summary ... --option a:A --option b:B --decision a:"what was decided" --json` |
| Update an item | `AGENT_INBOX_SESSION=$S agent-inbox patch <id> --set key=value --set key:=<json> --if-version N --json` |
| Delete an item created by mistake | `AGENT_INBOX_SESSION=$S agent-inbox delete <id> --if-version N` |
| Take back an open ask of yours that no longer applies (the human sees "Withdrawn" in History, not a decision) | `AGENT_INBOX_SESSION=$S agent-inbox withdraw <id> --if-version N --note "<why>" --json`; exit 3 `not_open` → the human decided first: handle it as a decision |
| `orchestrators/<ID>` doc, create or replace | `AGENT_INBOX_SESSION=$S agent-inbox orch set O3 --file orch.json --json` (at spawn, before the manager gets its token) |
| Refresh every live manager's `session_url` (the bridge id changes on some resumes) | `AGENT_INBOX_SESSION=$S agent-inbox orch relink --all --json` once per tick; add `--seed` the first time, to fill `session_id` from the transcripts. Needs `session_id` (the Claude session uuid) on the doc; a stopped session keeps its last link; one manager: `orch relink O3 [--session-id <uuid>]`. It reads `~/.claude/sessions`; sessions under another `CLAUDE_CONFIG_DIR` need `AGENT_INBOX_SESSION_DIRS` ([cli.md](cli.md#session-files)) |
| `orchestrators/<ID>` field update (`summary`, `headline`, `status`, `asks`) | `AGENT_INBOX_SESSION=$S agent-inbox orch set O3 --set status=pr-open --set summary="..." --set pr:='{"number":12,"url":"..."}' --json` |
| `meta/manager`: `last_pickup`, `next_tick` (pickup) | `AGENT_INBOX_SESSION=$S agent-inbox digest --json`. Without a body the digest is left alone, so a quiet pickup keeps the last sweep's digest. Pass a body (`digest - …` with a heredoc) only when the pickup changed something worth reporting |
| `meta/manager`: digest, `last_tick` (full sweep) | `AGENT_INBOX_SESSION=$S agent-inbox digest - --sweep --json <<'EOF'` … `EOF` |
| `tick_requested_at` newer than `last_tick`? | `agent-inbox meta get manager --json` → compare `data.tick_requested_at` with `data.last_tick` |
| Mirror schedule settings in `meta/manager` | Not needed: `meta/schedule` is the source of truth (see Schedule below) |
| A tick's writes in one `batch` | Lease renew and claims stay single calls, first (claim before acting). Then the rest of the tick's writes go in one `AGENT_INBOX_SESSION=$S agent-inbox batch --file - --json` (below): item posts/patches/answers/archives, `orchestrators/*` docs, the digest stamp last. All land or none do. Exit 3 → nothing was written: the stderr JSON's `index` and `current` name the doc that moved; re-read it, fix that op, resend the whole batch. Exit 3 `lease_held` (no `index`) → nothing was written and you lost the lease: step down |
| Comment wake (`ArtifactComments` watch) | `agent-inbox wait --human` (below) |
| Republish the page | Not applicable |

Item from a file (all briefing fields; the server stamps `created_at`/`updated_at` and defaults `status: open`):

```json
{
  "type": "decision",
  "title": "O3: keep D1 triggers for the change log?",
  "summary": "One-line lead.",
  "context": "Markdown: what this is and how we got here.",
  "command": "One shell command for the human to run, without the leading !.",
  "steps": "Markdown: what the human has to do, apart from the context. Put commands in ``` fences; the page shows them as code with a Copy button.",
  "question": "Which approach should O3 implement?",
  "options": [
    {"id": "keep", "label": "Keep triggers", "consequence": "...", "tradeoff": "...", "reversible": true},
    {"id": "worker", "label": "Write rows in the Worker", "consequence": "...", "tradeoff": "...", "reversible": false}
  ],
  "recommendation": {"option": "keep", "confidence": "high", "why": "..."},
  "cost_of_waiting": "O3 is idle until this is decided.",
  "evidence": [{"label": "Prototype notes", "url": "https://github.com/..."}],
  "orchestrator": "O3",
  "priority": "high",
  "source": "sweep:O3"
}
```

A tick's writes as one batch (each op is the body of the single write, plus `op` and `id`; pin every doc you read with its `version`):

```bash
AGENT_INBOX_SESSION=$S agent-inbox batch --file - --json <<'EOF'
{"ops": [
  {"op": "item.archive", "id": "O3-db", "if_version": 5},
  {"op": "item.qa", "id": "O4-api", "text": "B is cheaper because ...", "if_version": 3,
   "data": {"recommendation": {"option": "b", "confidence": "high", "why": "..."}}},
  {"op": "item.put", "id": "O5-ci", "if_version": 0, "data": {"type": "blocker", "title": "...", "orchestrator": "O5"}},
  {"op": "orchestrator.patch", "id": "O3", "if_version": 7, "data": {"status": "pr-open", "summary": "..."}},
  {"op": "meta.patch", "id": "manager", "data": {"last_pickup": "<now, ISO>", "last_tick": "<now, on a sweep>",
   "next_tick": "<computed.next_pickup_at>", "digest": "<markdown, only when it changed>"}}
]}
EOF
```

At most 50 ops; one doc at most once. Unlike the `digest` and `orch set --set` commands, ops don't create a missing doc on `patch`: create a new manager doc with `orchestrator.put` (`if_version: 0`), and `meta.patch manager` needs `meta/manager` to exist (any earlier `digest` or tick request made it; otherwise run `digest` once). Decide, snooze, delete, the tick request, lease, schedule, people, users and token writes aren't batchable.

## Wake path: Monitor until-loop

Pickups come from the ticker (Schedule below); `wait` wakes you early when the human acts. It long-polls the change feed, so an idle wait costs nothing in context.

At startup, after the first pickup has handled everything already decided, reset the cursor so old changes don't wake you:

```bash
mkdir -p ~/.cache/agent-inbox
agent-inbox changes --json | jq -r .cursor > ~/.cache/agent-inbox/manager.cursor
```

Then arm a Monitor (`timeout_ms: 1800000`, the maximum; re-arm when it expires):

```bash
while true; do
  agent-inbox wait --human --cursor-file ~/.cache/agent-inbox/manager.cursor --timeout 0 \
    || { echo "inbox wait failed (exit $?), retrying in 60s"; sleep 60; }
done
```

Each human change prints one line (`change 812  update  items/O3-x v4  decided  by human:you@example.com  at ...`) followed by `cursor 812`; each batch becomes one notification. Treat it like a comment wake: run a pickup (lease renew, decisions, questions, tick request). `--human` matches `human:*` and `hook:ntfy` (lock-screen buttons), except a Run-button click on the Reviews tab, which is for the review routine's poller, not you. A human's snooze never reaches your feed: it hides the item from their own Inbox only, and the item stays `open` for you. To also wake on managers' own posts, add `--actor token:orch-`. Network errors and 5xx are retried inside `wait` with backoff (on stderr, so they don't wake you). It exits only on a match or a hard error such as a revoked token (401); the loop then prints `inbox wait failed`, which does wake you, and you should check `agent-inbox me`.

For a single wake instead of a stream, run `agent-inbox wait --human --cursor-file ... --timeout 6600` with Bash `run_in_background` and re-launch it after each handled wake. Exit 4 means the timeout passed with no change: re-arm it without a pickup (background commands are killed after 2h).

## Schedule

`meta/schedule` is the source of truth for work hours and intervals. The human edits it from the phone (Settings), so read it rather than settling the skill's `work_hours`/`timezone`/`pickup`/`full_sweep` settings yourself:

```bash
agent-inbox schedule --json
```

```json
{
  "schedule": {"work_hours": "10:00-18:00 Mon-Fri", "timezone": "America/New_York", "pickup_interval_min": 10, "sweep_interval_min": 30},
  "version": 3,
  "computed": {"in_hours": true, "next_pickup_at": "...", "label": "10:00–18:00 ET, Mon–Fri", "utc_offset_min": -240, "cron_utc": ["3-59/10 14-21 * * 1-5"], "cron_exact": true}
}
```

- **Ticks come from the ticker, the lease from the heartbeat.** Both are scripts in [`skills/orchestration-manager/scripts/`](../skills/orchestration-manager/scripts/); the skill's Schedule and Single orchestrator sections say how to launch them, and each script's header documents it. The ticker reads `computed.next_pickup_at`, sleeps until that slot and exits; its completion is the tick, and you re-launch it after every tick. The heartbeat renews the lease every 5 minutes in work hours while the orchestrator's process lives. Because the ticker re-reads `meta/schedule` on every launch, a schedule or DST change needs no rebuild. Store the schedule `version` and `utc_offset_min` in the registry's Schedule line.
- **Every tick starts with `agent-inbox schedule --check || exit`.** It exits 0 in work hours and 5 outside them; on 5 the tick ends there with no writes and no report (re-launch the ticker first). Wakes from `wait` and subagent notifications are not gated: outside hours, handle only what woke you, as the skill says.
- **CronCreate is optional.** It didn't fire in the Remote Control orchestrator session, so treat a job as an extra, never the only source of ticks. To add one, create a job per entry in `computed.cron_utc` (two when the window crosses UTC midnight) with the tick prompt; `agent-inbox schedule --cron` prints just the expressions. The `schedule --check` gate applies to every firing: the cron covers whole UTC hours, so when `cron_exact` is false (a window like 09:30–17:30, or an interval that doesn't line up with the hour) some firings land outside work hours and the check skips them. Rebuild the job when a pickup's `schedule --json` shows a different `version` (the human changed the schedule) or a different `utc_offset_min` (DST). `cron_utc` is usable as-is only when the box's cron runs in UTC (`date +%Z` prints `UTC`); on a box in another zone, convert first.
- `pickup_interval_min` and `sweep_interval_min` replace the skill's `pickup` and `full_sweep` settings. The pickup interval divides 60 or is 60/120, so slots repeat every hour.
- `digest` sets `next_tick` to `computed.next_pickup_at` unless you pass `--next-tick` (fetch fails or no pickup: it stamps without it and warns on stderr).
- To change the schedule from the session (when the user asks in chat): `AGENT_INBOX_SESSION=$S agent-inbox schedule set --work-hours "09:00-17:00 Mon-Fri" --pickup 15`.

## Managers posting their own items

With the API, a manager no longer needs the orchestrator to turn its `BLOCKED:` line into an item: it posts the item itself with its scoped token, and the orchestrator sees it in the next pickup (or via `wait --actor token:orch-`).

At spawn, in this order:

1. Create its doc: `AGENT_INBOX_SESSION=$S agent-inbox orch set O3 --file orch.json --json` with `goal`, `status`, `motivation`, `session_title`, `session_url` and `session_id` (the Claude session uuid, so `orch relink` can keep the link current). (A manager token can also create its own doc, but the Team tab should show it from the start.)
2. Mint its token: UI Settings → Agent tokens (name `orch-O3`, scope `orchestrator`, manager `O3`), or `node scripts/create-token.mjs --name orch-O3 --scope orchestrator --orchestrator O3 --remote`.
3. Write `<state>/inbox/O3.json` (mode 600; `<state>` is the skill's state directory, `~/claude-orchestrator/` by default): `{"url": "<the url from your own ~/.config/agent-inbox/config.json>", "token": "ait_..."}` (that is `https://<your-host>/agent`).
4. In the brief, tell it to prefix every inbox command with `AGENT_INBOX_CONFIG=<state>/inbox/O3.json` and point it at [manager.md](manager.md).
5. Revoke the token in the UI when the manager is `done`.

A manager token can create and update only items with `orchestrator: "O3"`, can't decide or claim, and answers qa as `orchestrator`. The orchestrator still owns status moves: decided items for O3 are claimed, relayed and archived by you as before. (The server would let O3 archive its own decided item posted with `source: "O3"`, for agents that no orchestrator runs; manager.md tells O3 not to. If it does anyway, your pinned claim gets 409 and you skip the item, as with any failed claim.) When the user asks a question on an O3 item that only O3 can answer, either relay it as before or let O3 answer directly (`agent-inbox answer` with its token); both clear `qa_pending`.

**Dedupe `BLOCKED:` lines.** A manager that posts its own item still prints its `BLOCKED:` line, naming the item id. Before the sweep turns a `BLOCKED:` line into an item, list that manager's open items:

```bash
agent-inbox items --orchestrator O3 --status open --json
```

If one already covers the question (the id named in the line, or the same question), don't create a second; link to or update the existing one instead.
