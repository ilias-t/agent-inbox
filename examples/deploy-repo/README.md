# Deploy repo template

A private repo that deploys one agent-inbox instance. It holds a single workflow
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) and the instance's
Cloudflare credentials and settings. The code stays in the agent-inbox repo. Who can deploy
this instance is whoever can push to (or run workflows in) this repo, so give each instance
its own deploy repo with its own collaborators. Cloudflare tokens cover a whole account, so an
instance other people must not reach also needs its own Cloudflare account.

Full walkthrough, including the Cloudflare side: [docs/deploy.md](../../docs/deploy.md),
"Deploy from a private deploy repo".

## Set it up

```bash
gh repo create <you>/<instance>-deploy --private --clone && cd <instance>-deploy
mkdir -p .github/workflows
cp <path to agent-inbox>/examples/deploy-repo/.github/workflows/deploy.yml .github/workflows/
# edit the `uses:` line: <owner>/agent-inbox and a full commit SHA from it

R=<you>/<instance>-deploy
gh secret set CLOUDFLARE_API_TOKEN --repo "$R"     # paste the token (Workers Scripts Edit + D1 Edit)
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$R"    # paste the account id (npx wrangler whoami)
gh variable set D1_DATABASE_ID --repo "$R" --body "<database id from npx wrangler d1 create>"
gh variable set ACCESS_TEAM_DOMAIN --repo "$R" --body "<team>.cloudflareaccess.com"
gh variable set ACCESS_AUD --repo "$R" --body "<Access application AUD tag>"
gh variable set PUBLIC_URL --repo "$R" --body "https://agent-inbox.<your-subdomain>.workers.dev"
# optional:
gh variable set WORKER_NAME --repo "$R" --body "agent-inbox"   # another name for a second instance in the same account
gh variable set EXTRA_VARS --repo "$R" --body '{"CHANGES_RETENTION_DAYS":"60"}'

git add . && git commit -m "Deploy agent-inbox" && git push   # the push deploys
```

| Name | Kind | What |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | Account API token with Workers Scripts Edit and D1 Edit. Without it, runs only check the code. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | The Cloudflare account the instance lives in. |
| `D1_DATABASE_ID` | variable | The instance's D1 database. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | variables | From the Access application that covers the whole host. |
| `PUBLIC_URL` | variable | `https://<host>`; the smoke test calls it after each deploy. |
| `WORKER_NAME` | variable, optional | Defaults to `agent-inbox`. Two instances in one Cloudflare account need different names. |
| `EXTRA_VARS` | variable, optional | JSON object of more Worker vars. |

A missing or placeholder value fails the run before migrations, so nothing half-configured reaches Cloudflare.

## Ship a newer agent-inbox

Change the commit SHA (and the comment beside it) in the `uses:` line and push. The run applies new
migrations, deploys, and checks that the new Worker answers and reports the newest migration.
