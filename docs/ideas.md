# Future ideas

Ideas that aren't built yet, roughly ordered by value, with what each would take. What already shipped is listed at the bottom.

## Team inbox, next steps

Assignees, per-person ntfy topics and roles shipped (below). What's left:

- **Assignee in the change log.** Add an `assignee` column to `changes` the way migration 0002 added `orchestrator`, so `wait` can filter on it (`wait --human --assignee me`). Only worth it with several orchestrators or per-person agents; a single orchestrator wakes on every human change anyway.
- **Who tapped an ntfy button.** Taps land as `hook:ntfy`, which loses the person. Sign their email into the action link and record `hook:ntfy:<email>`.
- **Assignee-only decisions.** An assignee routes, it doesn't lock: anyone allowed to decide can, and the first decision wins, so someone else can unblock an agent when the assignee is away. For decisions that carry real ownership (spend approvals, prod deploys), a per-item `assignee_only: true` with an explicit "take over" that reassigns first.
- **Per-person hours.** `meta/schedule` is the team's coverage window, which is what the orchestrator needs. Per-person hours would only matter for routing (assign to whoever is in hours).
- **Several orchestrators.** One orchestrator per deployment today: one lease, one `meta/manager`, one digest. More would need a lease and a `meta/manager` per orchestrator, items scoped to an orchestrator the way manager tokens are scoped to a manager, and per-orchestrator change feeds. That is most of the way to multi-tenancy.
- **Multi-tenancy.** Non-goal for now: a `workspace_id` on every row, per-workspace tokens, schedule and lease. Worth it only if the inbox is offered to many separate teams; until then, one deployment and one D1 database per team is the boundary.
- **Wording.** The docs and skills say "the human" or "the user" and assume one person acts ("the human edits the schedule"). Where it matters who acts, say "a teammate" or "the assignee".

## Scale and safety

From an architecture review (2026-10-08). In progress: the CLI's `decide` pins the version it read, and opt-in
lease enforcement on orchestrator writes (an orchestrator that lost a takeover gets 409 `lease_held` instead of writing beside
the new holder).

- **Retention for archived items.** The change log is pruned, but archived items stay in `docs` forever; the archived
  count is the most expensive read in a delta. Whether to keep everything is a product call (how much History the
  team wants), so nothing is deleted until the owner decides.
- **Push instead of polling.** Each waiting client queries D1 every 1.5 s: cheap and stateless at one team's scale.
  Durable Objects with fan-out would cut latency and reads, but it's a big change with little payoff now; revisit if
  usage grows a lot.
- Done: the GitHub webhook finds a PR's items and managers through the `doc_links` index (migration 0008)
  instead of reading every doc.
- Checked and fine: static UI assets rely on Access alone but hold no data; doc and user deletes show an empty actor in
  the change log (cosmetic; snooze deletes keep the snoozer).

## Public release

The repo is source-available under the FSL-1.1-MIT license ([LICENSE.md](../LICENSE.md)).

- **Deployment config.** Tests and CI use `wrangler.test.jsonc`. An instance's own `wrangler.jsonc` (its D1 `database_id`, Access team domain and AUD, host) comes from `wrangler.example.jsonc` or the deploy action ([deploy.md](deploy.md)) and doesn't belong in the repo.
- **Before a release**, scan the tree for secrets (gitleaks, trufflehog) and for owner-specific strings.
- **Personal references.** Docs, skills and fixtures use placeholders (`example.workers.dev`, `you@example.com`). Setup-specific rules for the orchestration-manager skill (accounts, machine limits, standing approvals) live in its user's untracked `local-conventions.md`, not in the skill. Keep the check for owner-specific strings outside the repo, so the list of names doesn't ship with it.
- **`github.com/ilias-t/agent-inbox` links** (the CI badge, the [manager.md](manager.md) example, `test/cli/cli.test.ts`, `scripts/fixtures/sample-export.json`) are the repo's own URL: fine while it stays there, swap for an example repo if it moves.

## Other agent CLIs

The orchestration-manager skill drives Claude Code (`claude --bg`, background Bash ticks, SendMessage, PushNotification). The inbox, the CLI and the agent-inbox skill work with any agent; an orchestrator for Codex or Cursor would need its own skill.

## Shipped

- **Team inbox.** `assignee` with a filter and index (migration 0003), Mine / Unassigned / All and reassign on the item page; per-person ntfy topics; a `users` table with admin / decider / viewer roles managed in Settings → People, replacing `meta/people` and the `ADMIN_EMAILS` env var (migration 0005; [deploy.md](deploy.md#people-and-roles)).
- **Web Push** to the installed app, with a push-service host allowlist, and an **offline shell** ([deploy.md](deploy.md#web-push)).
- **Per-person snooze** (migration 0007) and **History search and paging**: `/api/state?archived=100`, `GET /api/items?q=&before=&limit=` ([api.md](api.md)).
- **Decide hardening.** A decision is pinned to the version the human saw (page and ntfy links alike), and decide accepts only the choices the item offers.
- **Agents without an orchestrator.** The [agent-inbox skill](../skills/agent-inbox/SKILL.md), and a manager token can archive its own decided item ([api.md](api.md) "Archiving your own item"). The orchestrator claims, answers and archives only its own items.
- **Batch writes.** `POST /api/batch` and `agent-inbox batch`: up to 50 pinned writes in one transaction.
- **Unique token names.** A live token's name is unique, so `token:<name>` in the change log names one token.
- **Change log pruning.** A daily Cron Trigger keeps 30 days (`CHANGES_RETENTION_DAYS`) and drops spent snoozes.
- **Ops.** CI with a Playwright e2e suite, deploy on merge, security headers with a strict CSP and bundled fonts.
- **Public-release prep.** `wrangler.example.jsonc`, README "Deploy your own", CONTRIBUTING, seed-data screenshots, no personal references in docs, skills or fixtures, the single-tenant note in the README.
