# Contributing

Thanks for helping. Bug reports and ideas go in [issues](https://github.com/ilias-t/agent-inbox/issues/new/choose); for anything bigger than a small fix, open an issue first so we can agree on the shape before you write it. Security problems go through [SECURITY.md](SECURITY.md), not issues.

## Setup

Follow the README's [Try it locally](README.md#try-it-locally): Node ≥ 22.9, `npm ci`, a `wrangler.jsonc` copied from `wrangler.example.jsonc`, `.dev.vars` from `.dev.vars.example`, and `npm run worker:dev`. You don't need a Cloudflare account; everything runs against a local D1 in `.wrangler/`.

For UI work, run Vite with hot reload next to the Worker:

```bash
npm run worker:dev    # terminal 1: the Worker and API on :8787
npm run dev           # terminal 2: Vite on :5173, proxying /api, /agent and /hooks to :8787
```

Open http://localhost:5173. Vite's proxy expects the Worker on port 8787. If it runs elsewhere (`npm run worker:dev -- --port 8788`), point the proxy at it with `WORKER_DEV_URL=http://localhost:8788 npm run dev`.

Install dependencies with `npm ci`. To add or bump a dependency, use npm 11 (`npx npm@11 install -D <pkg>@<version>`): npm 10, which ships with Node 22, can crash with `Cannot read properties of null (reading 'edgesOut')` when it changes this dependency tree.

## Before you send a change

```bash
npm run check    # typecheck, tests (Worker in workerd, UI/shared/CLI in node), build
npm run e2e      # if you touched the UI or the core loop (below)
```

CI (`.github/workflows/ci.yml`) runs the same `npm run check` on every pull request, and the end-to-end suite as a separate `e2e` job. It needs no Cloudflare credentials and never deploys.

Conventions:

- Every change comes with tests: Worker behaviour in `test/worker/`, CLI in `test/cli/`, UI helpers in `test/app/`. A change to the core loop (inbox, item page, deciding, live updates) keeps `npm run e2e` green, and a new flow there gets an e2e test.
- Keep the CLI and the API backward compatible. Agents run the recipes in `docs/orchestrator.md` and `docs/manager.md` literally, so commands, flags, exit codes and API paths don't change meaning; add, don't rename.
- API changes start in `docs/api.md` (and `shared/types.ts`), then the code.
- Any CLI command or flag change updates `docs/cli.md` and `docs/orchestrator.md` in the same change.
- A schema change is a new file in `migrations/`. Never edit a migration that has shipped: deployments have already applied it.
- No secrets in the repo: they go in `.dev.vars` locally and `wrangler secret put` in production. Keep real hostnames, emails and deployment ids out of code, tests and screenshots; use `example.com`-style placeholders.

Pull requests: keep each one to one change, fill in the template, and say how you tested it. A maintainer reviews and merges.

## End-to-end tests

`e2e/` is a small Playwright suite (Chromium only) that drives the built UI against a real `wrangler dev` and guards the core loop: the inbox, opening and deciding items, "Other…", asking a question, "Looks good", j/k navigation, the phone bottom-bar Submit, snoozing, History paging and search, Settings (People included), live updates from a token-authenticated CLI write, and the security headers with no CSP violations. It isn't part of `npm run check`, so that stays fast.

```bash
npx playwright install chromium   # once (on Linux, add --with-deps for the OS libraries)
npm run e2e                       # typecheck e2e/, then the whole suite
npm run e2e -- -g "Other"         # tests whose title matches
npm run e2e:ui                    # Playwright's UI mode: pick tests, watch them, time-travel
npx playwright test --headed      # watch it in a real browser window
```

How it runs (`e2e/global-setup.ts`): build the UI (skip with `E2E_SKIP_BUILD=1` when `dist/` is current), recreate a local D1 in `.wrangler/e2e` (migrations, plus an orchestrator token minted with `scripts/create-token.mjs`), then start `wrangler dev` on free ports with `e2e/dev.env` (`DEV_NO_ACCESS=1`) in place of your `.dev.vars`. Your own `.wrangler/state`, `.dev.vars` and a `wrangler dev` you already have running are left alone. The server stops when the run ends; its output is in `.wrangler/e2e/wrangler.log`.

Every test starts from the seed data (`scripts/fixtures/sample-export.json`): the `seeded` fixture in `e2e/fixtures.ts` empties the docs table and reseeds it before each test, so tests don't depend on order. They share one server and database, so they run one at a time.

Writing tests: import `test`, `expect` and the helpers from `e2e/fixtures.ts`; select by role and accessible name (`getByRole`, `getByLabel`) and add a `data-testid` only where an element has no accessible handle. Service workers are blocked, so a production-only worker can't cache the page under test. CI retries a failed test once as a backstop; a test that needed it is flaky and gets fixed, not retried.

Debugging a failure:

- Locally, a failed test keeps a trace, a screenshot and `error-context.md` (the page's accessibility snapshot) in `test-results/<test>/`. Open the trace with `npx playwright show-trace test-results/<test>/trace.zip` (every action with the DOM before and after, network, console), or the HTML report with `npx playwright show-report`.
- In CI, a failed `e2e` job uploads the `playwright-report` artifact (the HTML report, `test-results/` with the traces, and the server log). Download it from the run's Summary page, unzip it, and run `npx playwright show-report playwright-report` or `npx playwright show-trace test-results/<test>/trace.zip`; https://trace.playwright.dev opens a trace in the browser too.
- `PWDEBUG=1 npm run e2e -- -g "<title>"` steps through one test in the Playwright Inspector.

## Releases

A release is a version tag plus its notes. Deploy repos pin a release's commit, and Dependabot proposes the next tag to them ([examples/deploy-repo](examples/deploy-repo/README.md#with-dependabot)), so tags are never moved or deleted once pushed. Versions follow semver. While on `0.x`, a minor release brings features or migrations and a patch release brings fixes only.

To cut `vX.Y.Z` (maintainers):

1. In a pull request, add a `## vX.Y.Z (YYYY-MM-DD)` entry at the top of [CHANGELOG.md](CHANGELOG.md), written from `git log --oneline v<previous>..origin/main`. Keep it to what users notice, and name every new migration, setting, secret or deploy step. Use full `https://github.com/...` links, since the entry also becomes the release page. Set `"version"` in `package.json` with `npm version X.Y.Z --no-git-tag-version`. Merge it.
2. Tag the merge commit and publish the notes. `gh` creates the tag:

   ```bash
   awk '/^## vX\.Y\.Z /{f=1; next} /^## /{f=0} f' CHANGELOG.md > notes.md
   gh release create vX.Y.Z --target <merge commit sha> --title "vX.Y.Z" --notes-file notes.md
   ```

   For a tag that's already pushed, `gh` ignores `--target`. Pass `--verify-tag` instead, so a mistyped tag fails rather than creating a new one.

## License of contributions

agent-inbox is source-available under [FSL-1.1-MIT](LICENSE.md): free to use, modify and self-host, including at work, but not to offer as a competing commercial product or service, and each release becomes MIT two years after it's published. By sending a pull request you agree that your contribution is licensed under the same terms. There is no contributor license agreement to sign.
