## What and why

<!-- What this changes and the problem it solves. Link the issue if there is one. -->

## How it was tested

<!-- The commands you ran and what you checked by hand. -->

- [ ] `npm run check` passes
- [ ] `npm run e2e` passes (if the UI or the core loop changed)

## Checklist

- [ ] Tests cover the change (`test/worker/`, `test/cli/`, `test/app/`, or `e2e/` for a new flow)
- [ ] The CLI and API stay backward compatible, or the break is called out above
- [ ] Docs updated: `docs/api.md` for API changes, `docs/cli.md` and `docs/orchestrator.md` for CLI changes
- [ ] Schema changes are a new migration, not an edit to an existing one
- [ ] No secrets, real hostnames, emails or deployment ids in code, tests or screenshots
