# agent-inbox vs the Artifact inbox (v4)

Written 2026-10-07 at the end of the build, for deciding whether to switch the orchestration manager over. **Historical:** this is the record of that decision, left as written. It predates team use (assignees, roles), Web Push, snooze, batch writes and History search, so where it describes agent-inbox, the [README](../README.md) and [api.md](api.md) are current. The screenshots it links have since been retaken from the current UI.

## Verdict

Switch, after a few days of running both side by side. The two things the artifact can't do (managers posting their own items, and a cheap, reliable wake path) work, and everything else is at parity. The costs are a separate URL with a Google sign-in, and losing the comment wake, which `wait --human` replaces. Confidence: medium-high.

Screenshots at 390 px with seed data: [inbox](screenshots/1-inbox.png), [item briefing](screenshots/2-item.png), [manager, dark](screenshots/5-orch-dark.png), [settings, dark](screenshots/6-settings-dark.png).

## Parity

| Feature | Artifact v4 | agent-inbox | Notes |
|---|---|---|---|
| Inbox index (priority groups, FYI group, badge, counts) | ✅ | ✅ | Ported unchanged |
| Item show page with decision briefing | ✅ | ✅ | Same order and fields |
| Options with consequence / tradeoff / reversible, recommendation, Other… with note | ✅ | ✅ | |
| auto_decided: Looks good / Override… | ✅ | ✅ | |
| Ask thread (qa) with "waiting for the orchestrator" | ✅ | ✅ | Thread refreshes from the change feed (~2 s), not a live subscription |
| Team tab, manager briefing (Why / Goal / Where it stands / Needs from you), Open chat | ✅ | ✅ | |
| History tab, timeline, answered dot | ✅ | ✅ | |
| Run tick now (+ note) | ✅ | ✅ | |
| Lease / heartbeat header, "orchestrator may be down" | ✅ | ✅ | |
| Orchestrator digest, last/next tick, overdue | ✅ | ✅ | |
| Dark / light themes | ✅ (system) | ✅ | Plus a manual System / Light / Dark switch in Settings |
| Live updates | ✅ (db snapshots) | ✅ | Long-poll on `/api/changes`, ~1.5–2 s |
| Configurable schedule (work hours, pickup, sweep) | ⚠️ orchestrator-written only | ✅ | Settings screen, `agent-inbox schedule`, header shows next pickup / off hours |
| Send-to-Claude comment wake | ✅ | ❌ | No equivalent. Replaced by `agent-inbox wait --human` (orchestrator runs it in a Monitor loop) |
| Opens inside the Claude app | ✅ | ❌ | A separate URL behind Cloudflare Access (Google sign-in, 30-day session). Add it to the home screen |
| Orchestrator writes | ArtifactData, batches of ≤ 50 atomic | ✅ | `agent-inbox batch`: ≤ 50 pinned writes in one D1 transaction, all or none. Lease renew and claims stay single calls |
| Managers post their own items / answer qa | ❌ | ✅ | Scoped tokens; can only touch their own items |
| Event-driven updates | ❌ | ✅ (not yet configured) | GitHub webhook sets `pr_state`; needs `GITHUB_WEBHOOK_SECRET` + a webhook per repo |
| Lock-screen approve | ❌ | ✅ (not yet configured) | ntfy push with signed Approve/Reject; needs `NTFY_TOPIC` + `NTFY_ACTION_SECRET` |
| Tests | ❌ | ✅ | 242 (API in workerd with D1, UI helpers, CLI, schedule) |
| Teammates | ❌ | ⚠️ | Add emails to the Access policy; the data model has no per-user views yet |

## Costs and limits

See "Costs and limits" in [deploy.md](deploy.md#costs-and-limits): free-tier sized; about $0 marginal on Workers Paid. `/api/state` returns all items, fine for months at this volume; the change log is pruned to 30 days.

## What switching takes

1. Export the artifact's collections and import them: `node scripts/import-artifact.mjs <export> --remote` ([deploy.md](deploy.md#import-from-the-artifact)).
2. Point the orchestration-manager skill at the CLI: replace its ArtifactData calls with the mapping in [orchestrator.md](orchestrator.md), its schedule mirror with `agent-inbox schedule`, and the comment watch with `agent-inbox wait --human`.
3. Optional: ntfy and GitHub webhook secrets.
