# Manager guide: posting to the inbox

You are a manager (say `O3`) with a scoped inbox token. Use it to put a question in front of the human when you are blocked, check whether they decided, and answer their follow-up questions. The orchestrator still relays decisions and owns every status change on your items. An agent that no orchestrator launched follows the [agent-inbox skill](../skills/agent-inbox/SKILL.md) instead.

## Setup

The orchestrator wrote your config to a file, `<state>/inbox/O3.json` in its state directory (your brief gives the full path); prefix every command with it (shell variables don't persist between Bash calls):

```bash
AGENT_INBOX_CONFIG=<state>/inbox/O3.json agent-inbox me --json
# {"kind":"token","name":"orch-O3","scope":"orchestrator","orchestrator":"O3"}
```

Below, `ai` stands for `AGENT_INBOX_CONFIG=<state>/inbox/O3.json agent-inbox`.

## What you can do

- Create and update items whose `orchestrator` is `O3` (status stays `open`).
- Create `orchestrators/O3` if the orchestrator hasn't (`ai orch set O3 --set goal="..." --set status=running`), and keep it current.
- Read your items, their Q&A, `orchestrators/O3`, the schedule, and your own changes.
- Answer questions on your items; update `orchestrators/O3` (`headline`, `summary`, `asks`).
- Not: decide, claim or delete items; touch other managers' items; manage the lease. Those return 403.
- Don't archive either. The server lets a manager token archive its own `decided` item posted with `--source <its id>` (that is how an agent with no orchestrator closes its item), and it can't tell you from such an agent. But the orchestrator claims your decided items to relay them and update its registry; if you archive first, its claim fails and that bookkeeping is skipped. Leave archiving to the orchestrator.
- You may withdraw your own question while it is still `open` and no longer applies (`ai withdraw <id> --if-version N --note "<why>" --json`, on an item posted with `--source O3`): an open item isn't the orchestrator's to claim yet, so this doesn't race its bookkeeping. Exit 3 means the human decided first; leave that decision to the orchestrator's relay.

## Post a blocker or decision

Use the id `O3-<slug>`. Write it so it can be decided cold from a phone: lead, context, the exact question, options with consequence/tradeoff/reversible, a recommendation, cost of waiting and evidence links.

```bash
ai post O3-db-choice --json \
  --type decision --priority high --orchestrator O3 --source O3 \
  --title "Postgres or SQLite for the job queue?" \
  --summary "Need a call before I write the migration. Recommend Postgres." \
  --question "Which store should the job queue use?" \
  --context "The queue needs row locks for workers; SQLite serialises writers." \
  --option "pg:Postgres:Uses the existing cluster" \
  --option "sqlite:SQLite:One file next to the worker" \
  --recommend "pg:high:Row locks and we already operate it" \
  --cost-of-waiting "I'm idle until this is decided." \
  --evidence "Benchmark=https://github.com/ilias-t/agent-inbox/issues/21"
```

For per-option `consequence`, `tradeoff` and `reversible`, write the item as JSON and post it with `--file item.json` (or `--file -` from a heredoc); the fields are in [orchestrator.md](orchestrator.md). Exit 3 means the id already exists; pick another id or update it with `ai patch`.

Still print your usual `BLOCKED:` line in the transcript, and name the item in it (`BLOCKED: O3-db-choice — Postgres or SQLite for the job queue?`). The orchestrator's sweep matches the line to your item instead of posting a duplicate.

## Check for the decision

```bash
ai show O3-db-choice --json            # .item.data.status and .item.data.decision
ai wait --id O3-db-choice --status decided,processing --timeout 0   # blocks until decided
```

The orchestrator claims a decided item (`processing`), relays the choice to you and archives it. If you see the decision first, act on it; the orchestrator's relay will match.

Once it is decided, the item is the record of what the human approved: your token can no longer change its content (title, question, options, links, ...; 403). You can still reassign it and answer questions on it. Report progress on your manager doc (`ai orch set`), not on the item.

## Answer a question

The human can ask a question on your item before deciding (`qa_pending: true`).

```bash
ai items --qa-pending --json           # your items with a pending question
ai qa O3-db-choice --json              # the thread, oldest first
ai answer O3-db-choice --if-version 4 --json "Postgres: the queue needs SKIP LOCKED; see the benchmark."
```

`--if-version` is the item's `version` from your read. Exit 3 means the item changed (they asked again or decided): re-read and answer again if `qa_pending` is still true. When the answer changes the briefing, add `--set` flags (for example `--set recommendation:='{"option":"sqlite","confidence":"medium","why":"..."}'`) to update the item in the same write. Any write retires the lock-screen buttons the human already got for the item; your answer's push carries fresh ones.

## Keep your briefing current

```bash
ai orch set O3 --set headline="Migration written, waiting on review" --set summary="..." --json
```
