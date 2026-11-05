# Changelog

Each release is a `vX.Y.Z` tag with notes on [GitHub Releases](https://github.com/ilias-t/agent-inbox/releases). The CLI and the HTTP API stay backward compatible across releases; the UI changes freely. Deploy repos pin a release ([examples/deploy-repo](https://github.com/ilias-t/agent-inbox/blob/main/examples/deploy-repo/README.md)), so each entry calls out what a deploy needs: new migrations, settings or secrets.

## v0.1.0 (2026-11-05)

The first public release. agent-inbox is a phone-first inbox where coding agents ask a human for decisions. It is one Cloudflare Worker with a D1 database, behind Cloudflare Access, plus a CLI and agent skills.

- **Web app.** Installable on a phone, works offline. The Inbox is grouped by priority. Decision briefings show options with tradeoffs, reversibility and a recommendation, and a decision is bound to the version you saw. You can ask a question before deciding, or snooze. Also: Team and History tabs, History search, keyboard shortcuts, and light and dark themes.
- **Reviews tab** for a PR review runner that reports to the inbox ([docs/reviews.md](https://github.com/ilias-t/agent-inbox/blob/main/docs/reviews.md)).
- **Notifications:** Web Push, optional ntfy with signed approve/reject buttons, and an optional GitHub webhook that updates items when their PRs are merged or reviewed.
- **People:** roles (admin, decider, viewer) and item assignment.
- **CLI** (`bin/agent-inbox.mjs`, Node ≥ 22, no dependencies) for agents ([docs/cli.md](https://github.com/ilias-t/agent-inbox/blob/main/docs/cli.md)): scoped tokens, a long-polling change feed (`wait`), version-pinned and batch writes, and an orchestrator lease.
- **Skills:** [`skills/agent-inbox`](https://github.com/ilias-t/agent-inbox/blob/main/skills/agent-inbox/SKILL.md) lets a single agent ask and wait. [`skills/orchestration-manager`](https://github.com/ilias-t/agent-inbox/blob/main/skills/orchestration-manager/SKILL.md) runs a Claude Code session that manages one session per approved goal.
- **Deploy:** a composite action and a deploy-repo template for deploying an instance from its own private repo ([docs/deploy.md](https://github.com/ilias-t/agent-inbox/blob/main/docs/deploy.md)).
- **Database:** migrations `0001`–`0011`.
