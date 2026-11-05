# Deploying agent-inbox

One Worker (`agent-inbox`) and one D1 database (`agent-inbox`) in your Cloudflare account, behind Cloudflare Access. Below, `<your-host>` is the Worker's host, the host part of `PUBLIC_URL` in `wrangler.jsonc` (for example `agent-inbox.<your-subdomain>.workers.dev`).

## Config files

| File | Tracked | Used by |
|---|---|---|
| `wrangler.example.jsonc` | yes | The template: every instance's config is this file with its own values filled in. |
| `wrangler.test.jsonc` | yes | `npm run check` and `npm run e2e`. Fake ids and `*.test` hosts, so tests need no private file. |
| `wrangler.jsonc` | no (gitignored) | Your own copy: `npm run worker:dev`, `npm run deploy`, `npm run db:migrate:*`, and `scripts/*.mjs` unless you pass `--config`. |

**Local development** needs only a copy of the example: `cp wrangler.example.jsonc wrangler.jsonc`, then `npm run worker:dev` as in the README. The local D1 doesn't care that `database_id` is still a placeholder. Fill the values in when you deploy (below). To keep configs for several instances, name them `wrangler.<instance>.jsonc` (gitignore them), pass `--config` to wrangler and the scripts, or generate them with `scripts/wrangler-config.mjs` ([Deploy from a private deploy repo](#deploy-from-a-private-deploy-repo)).

## First deploy

```bash
npx wrangler login
npx wrangler d1 create agent-inbox             # prints the database_id
cp wrangler.example.jsonc wrangler.jsonc       # fill database_id and PUBLIC_URL now; ACCESS_* after the Access step
npm run deploy                                 # typecheck + tests + build, apply remote migrations, wrangler deploy
# set up Access (below), fill ACCESS_TEAM_DOMAIN and ACCESS_AUD, then:
npm run deploy
```

Instead of `wrangler login` you can export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The comments in `wrangler.example.jsonc` say where each value comes from. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` come from the Access setup below, so the usual order is: create D1, deploy once to get the host, set up Access, fill the two values, deploy again. Until both are set, every browser `/api` call gets 401, so the first deploy exposes nothing but the static page.

## Cloudflare Access

Add two self-hosted applications in the Zero Trust dashboard (Access → Applications):

| Access application | Covers | Policy |
|---|---|---|
| `agent-inbox` | `<your-host>` (whole host) | Allow your email (session 30 days) |
| `agent-inbox agents and hooks` | `<your-host>/agent`, `<your-host>/hooks` | Bypass everyone: the Worker checks bearer tokens and webhook signatures itself |

Copy the first app's AUD tag and the team domain (`<team>.cloudflareaccess.com`) into `wrangler.jsonc` → `vars` (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`) and deploy. The Worker verifies the Access JWT on every browser `/api` call, so the API fails closed if Access is ever removed.

Then check:

```bash
curl -sI https://<your-host>/ | head -1        # 302 to the Access login
curl -s https://<your-host>/agent/api/me       # 401 "Bearer token required"
agent-inbox me                                 # with a token in ~/.config/agent-inbox/config.json
```

`workers_dev` is on and preview URLs are off, because Access does not cover preview URLs.

To let more people in, add their emails to the first app's policy, then give them a role in **Settings → People** ([People and roles](#people-and-roles)). Access decides who can sign in; the role decides what they can do.

## Security headers

All of them come from [`shared/security-headers.ts`](../shared/security-headers.ts):

- **The UI** (the page, `/assets/*`, `sw.js`, the manifest, icons) is served by Workers static assets without running the Worker, so its headers go in `dist/_headers`, which [Workers static assets applies](https://developers.cloudflare.com/workers/static-assets/headers/) to every file it serves (`wrangler dev` too). The build writes that file (`vite.config.ts`): a strict Content-Security-Policy (everything `'self'`, no `'unsafe-inline'`, `frame-ancestors 'none'`), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, a `Permissions-Policy` that turns off camera, microphone, geolocation and the like, `Cross-Origin-Opener-Policy: same-origin` and `Strict-Transport-Security: max-age=31536000`. The same file sets caching: `/assets/*` (Vite's content-hashed names, which never change content) gets `Cache-Control: public, max-age=31536000, immutable`, `/sw.js` gets `no-cache` so an installed app sees a deploy on its next update check, and the page keeps the static-assets default (`public, max-age=0, must-revalidate`). The catch-all `/*` rule sets no `Cache-Control`, because a header set by two matching rules is joined with a comma.
- **The one inline script** (index.html's theme, which has to run before first paint) is allowed by its SHA-256, which the build computes from the built `dist/index.html`, so editing the script can't leave a stale hash. The build fails if the page gains a `style` attribute, an inline handler, a `javascript:` URL or a script or stylesheet from another origin. Views use classes, never `style=` (`test/shared/security-headers.test.ts` checks `src/`), and the Geist fonts are bundled from npm rather than loaded from Google Fonts.
- **API and hook responses** are built by the Worker, and `_headers` is "not applied to responses generated by your Worker code", so `worker/http.ts` sets theirs: `Cache-Control: no-store`, `nosniff`, and `Content-Security-Policy: default-src 'none'`.

Access is unaffected: its login pages are on `<team>.cloudflareaccess.com`, the unauthenticated 302 to them comes from Access before the Worker or the assets (so it carries none of these headers), and the UI's API calls use `redirect: "manual"`, so an expired session never fetches the login page under the CSP. To see the headers on the live site, use an authenticated request (`cloudflared access curl https://<your-host>/ -I`) or the browser's network panel; `e2e/security.spec.ts` checks them, and that the pages raise no CSP violations, against `wrangler dev`.

## First token

Mint tokens in the UI (**Settings → Agent tokens**, `#settings`) or, before the UI is reachable, with the script (needs wrangler credentials for `--remote`):

```bash
node scripts/create-token.mjs --name orchestrator --scope manager --remote
```

The token (`ait_<id>_<secret>`) is printed once. Scopes: [cli.md](cli.md#tokens-and-scopes).

## Redeploy and roll back

```bash
npm run deploy         # typecheck + tests + build, apply remote migrations, wrangler deploy
npx wrangler rollback  # back to the previous version
```

## Deploy from a private deploy repo

Automated deploys go through the deploy action, [`.github/actions/deploy`](../.github/actions/deploy/action.yml): `npm ci`, `npm run check` (the migration guard included), a Time Travel bookmark in the log, `wrangler d1 migrations apply agent-inbox --remote`, `wrangler deploy`, then a smoke check that `PUBLIC_URL/agent/api/me` answers 401 and that `PUBLIC_URL/agent/api/health` names the newest file in `migrations/` (the new Worker reads D1, with this deploy's migrations applied). Until the API token is set, it runs the checks, skips migrate and deploy with a notice, and passes.

Each instance deploys from **its own private repo** that calls the action, pinned to an agent-inbox commit. The deploy repo holds one small workflow, the instance's Cloudflare token and settings, and the collaborators who may deploy that instance. Instances deployed this way leave no ids, hosts or credentials in the code repo, and the code repo's contributors get no deploy access to them. [`examples/deploy-repo/`](../examples/deploy-repo/) is the template; its README lists every secret and variable with the `gh` commands to set them.

```yaml
# <instance>-deploy/.github/workflows/deploy.yml (abridged)
on: { push: { branches: [main] }, workflow_dispatch: {} }
concurrency: { group: deploy, cancel-in-progress: false }   # one at a time, never cut off mid-migration
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: <owner>/agent-inbox/.github/actions/deploy@<full commit sha> # <version>
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          d1-database-id: ${{ vars.D1_DATABASE_ID }}
          access-team-domain: ${{ vars.ACCESS_TEAM_DOMAIN }}
          access-aud: ${{ vars.ACCESS_AUD }}
          public-url: ${{ vars.PUBLIC_URL }}
```

How it fits together:

- **One pin.** GitHub downloads the whole agent-inbox repo at the pinned commit to run the action, and the action deploys that same tree. The steps and the code can't drift apart. To ship a newer agent-inbox, change the SHA and push; every push to the deploy repo's `main` deploys.
- **The config is generated.** The action writes the instance's wrangler config from [`wrangler.example.jsonc`](../wrangler.example.jsonc) and the inputs ([`scripts/wrangler-config.mjs`](../scripts/wrangler-config.mjs)). A binding, flag or cron added to the app reaches every instance with the next pin bump. An empty or placeholder value fails the run before migrations. You can run the script yourself to write a local `wrangler.jsonc` for an instance: `D1_DATABASE_ID=… ACCESS_TEAM_DOMAIN=… ACCESS_AUD=… PUBLIC_URL=… node scripts/wrangler-config.mjs --out wrangler.jsonc`.
- **Logs stay private.** Deploy logs print the host and the Access team domain, and they stay in the deploy repo.
- **Worker secrets** (`GITHUB_WEBHOOK_SECRET`, `NTFY_*`, `VAPID_*`) live on the Worker, not in the deploy repo. Set them once per instance with `npx wrangler secret put <NAME> --name <worker name>` (with that account's credentials).

### A second instance

Another instance is another deploy repo; the code doesn't change.

1. Pick its Cloudflare account. **Put an instance that other people must not reach in its own account.** Workers and D1 token permissions cover a whole account, so a token that can deploy one instance there can also deploy, read or migrate every other Worker and database in that account. Separate deploy repos only keep instances apart when their tokens are for different accounts. In that account: `npx wrangler d1 create <db name>` (any name; the config always calls it `agent-inbox`, and the id is what binds it), then the two Access applications for its host ([Cloudflare Access](#cloudflare-access)).
2. Create a private repo from [`examples/deploy-repo/`](../examples/deploy-repo/) with that instance's token, account id and values. If it shares a Cloudflare account with another instance (fine when the same people run both), set `WORKER_NAME` to a new name; its host becomes `<name>.<subdomain>.workers.dev`.
3. Push. The first run creates the Worker and its `workers.dev` host and applies every migration to the empty database.
4. Mint its first token with `node scripts/create-token.mjs … --remote --config <that instance's wrangler.jsonc>` (generated as above), or in its UI once Access lets you in.

Give each deploy repo only the collaborators who should deploy that instance. Anyone who can push a workflow there can use its token, so the token's account is everything they can reach.

This repo has no deploy workflow: its CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) only checks, with `wrangler.test.jsonc`.

### The Cloudflare API token

For a deploy repo, or for `npm run deploy` without `wrangler login`:

1. Create a token in the Cloudflare dashboard: **Manage account → Account API tokens → Create Token → Create Custom Token**. An account token is bound to that one account and outlives any one person's login. Permissions:

   | Scope | Permission | Access | For |
   |---|---|---|---|
   | Account | Workers Scripts | Edit | Upload the Worker and its static assets, enable `workers.dev` |
   | Account | D1 | Edit | Apply migrations |

   No zone permission is needed: the Worker has no routes, only `workers.dev`. A user token (**My Profile → API Tokens**) works too; set **Account Resources** to *Include → your account*. If a later wrangler fails with `Authentication error [code: 10000]`, start from the **Edit Cloudflare Workers** template instead and add **Account · D1 · Edit**.
2. Set the two secrets in the repo that deploys (the account id is in `npx wrangler whoami`):

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo>     # paste the token
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/<repo>    # paste the account id
   ```

3. Rerun the latest deploy (`gh workflow run deploy.yml --repo <owner>/<repo>`), or push something.

For `npm run deploy` from your machine, export the same two values in your shell instead (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`); wrangler reads them in place of a `wrangler login`.

Watch a run and roll back:

```bash
gh run watch           # pick the Deploy run
npx wrangler rollback  # back to the previous version; migrations are not rolled back
```

**The GitHub link index** (migration 0008) adds the `doc_links` table and three triggers on `docs`, and fills the table from the existing items and managers in the same migration. It changes no doc. The Worker live while it runs, and one brought back by `wrangler rollback`, never read the table, and their writes keep it current through the triggers. To take it out entirely, a later migration drops the three triggers (`doc_links_ai`, `doc_links_au`, `doc_links_ad`) and the table, once no deployed Worker reads it.

`npm run deploy` stays the manual path, with your own `wrangler login`.

## Backups and restore

Every deploy applies new migrations to the live D1 before anyone looks again, and `wrangler rollback` brings back the Worker, not the data. Three things cover that:

- **The migration guard.** `npm run check` (so CI and the deploy itself) fails on a migration that destroys data: `DROP TABLE`, `ALTER TABLE … DROP [COLUMN]`, or `ALTER TABLE … RENAME` (`scripts/lib/migration-guard.mjs`, `test/shared/migrations.test.ts`). Dropping an index or a trigger passes. A migration that means it carries a comment with the reason, and gets read with that in mind:

  ```sql
  -- migration-guard: allow doc_links is derived from docs, refilled by 0008's triggers
  DROP TABLE doc_links;
  ```

- **A bookmark per deploy.** The Deploy run logs the database's Time Travel bookmark (`wrangler d1 time-travel info agent-inbox`) in its "Bookmark the database" step, right before the migrations.
- **Time Travel.** D1 keeps every write for 30 days (7 on the Workers Free plan), so the database can go back to any minute in that window, the bookmark above included. A restore replaces the whole database in place, writes made since included, so stop the orchestrator and the routine first, and keep the bookmark the restore prints, which undoes it:

  ```bash
  npx wrangler d1 time-travel info agent-inbox                                  # the bookmark now
  npx wrangler d1 time-travel info agent-inbox --timestamp 2026-10-15T16:00:00Z # the bookmark at a time
  npx wrangler d1 time-travel restore agent-inbox --bookmark <bookmark>         # or --timestamp <time>
  ```

  Then `npx wrangler rollback` if the Worker live now expects the schema that was undone.

For a copy outside Cloudflare, `npx wrangler d1 export agent-inbox --remote --output agent-inbox-$(date +%F).sql` writes the whole database as SQL. It holds the token hashes, notes and decisions, so keep it private.

## Secrets

Each is optional; the feature stays off until it is set.

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET   # GitHub webhook
npx wrangler secret put NTFY_TOPIC              # ntfy push; a long random topic name
npx wrangler secret put NTFY_ACTION_SECRET      # signs ntfy approve/reject buttons
npx wrangler secret put NTFY_TOKEN              # only for a protected topic or self-hosted server
npx wrangler secret put NTFY_SERVER             # default https://ntfy.sh
npx wrangler secret put VAPID_PUBLIC_KEY        # Web Push key pair (optional: generated and kept in D1 when unset)
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT           # mailto: or https: contact for push services; default PUBLIC_URL
npx wrangler secret put PUSH_ENDPOINT_HOSTS     # only for a push service the built-in list misses (see Web Push); not secret, so `vars` works too
```

## People and roles

Every human Access lets in has a role, kept in D1 (the `users` table) and managed by admins in **Settings → People**:

| Role | Can |
|---|---|
| admin | Everything, including agent tokens, the schedule and people |
| decider | Read everything, decide, ask questions, snooze, Run tick now, reassign |
| viewer | Read everything |

Everyone also sets their own display name, ntfy topic and Web Push devices, whatever their role. The UI hides or disables what a role can't do (a viewer sees the decide buttons disabled with a note, and no Run tick now); the API refuses it with 403 either way. Tokens have no role: the orchestrator token keeps all its rights, but no token can change roles.

**Which role someone has**, checked on every request:

1. The role an admin saved for them.
2. Otherwise, if `ADMIN_EMAILS` lists them: admin. (Deprecated; see below.)
3. Otherwise, while no admin is saved yet: admin, or decider when `ADMIN_EMAILS` is set. This is how a deployment worked before roles, so an existing one changes nothing until someone saves an admin.
4. Otherwise: viewer. Adding someone to the Access policy never silently makes them a decider.

**Getting started.** On a fresh deployment (or one upgraded from before roles) everyone is an admin, and Settings → People says so. The first time an admin saves a role there, they're saved as admin too; from then on, people without a saved role are viewers. Add each teammate with a role there, and add them to the Access policy. The last admin can't be demoted or removed.

**Removing someone** deletes their role, name and topic and their Web Push devices. To keep them out, remove them from the Access policy as well: if Access still lets them in, they're a viewer.

**Web Push without a row.** Anyone Access lets in can turn on notifications on a device, whether or not they were added here, and their devices get the broadcast pushes (unassigned items). People lists them too, marked "not added here: only Web Push devices" with how many; **Remove** deletes those devices, and choosing a role adds them. Subscribing doesn't create a row: rows are what admins (and people saving a name or topic) write, every row write lands in the change log and wakes `wait --human`, and every teammate can list the rows (`GET /api/users`), so a row would tell them who enabled a device. Someone removed from Access should be removed here too, or their devices keep getting pushes.

**`ADMIN_EMAILS`** (comma-separated) is the old way to name admins. It still works as an override for people without a saved role, so a deployment that set it keeps its admins, and listed humans can get into Settings → People to save real roles. Once they have, remove it (`wrangler.jsonc` → `vars`, or `wrangler secret delete ADMIN_EMAILS`).

**Upgrading from before roles** (migration 0005). The migration copies everyone's name and ntfy topic from the old `meta/people` doc into `users`, with no role, so nobody's access changes on deploy. `meta/people` stays in D1 unused, so a `wrangler rollback` to an older Worker still finds it (edits made after the upgrade won't be in it). After the upgrade, open Settings → People and save the roles.

## ntfy

1. Pick a long random topic (`agent-inbox-$(openssl rand -hex 12)`); `wrangler secret put NTFY_TOPIC`.
2. `wrangler secret put NTFY_ACTION_SECRET` with `openssl rand -hex 32`; without it pushes carry only an Open button.
3. Subscribe to the topic in the ntfy app on the phone. Approve/Reject buttons call `/hooks/ntfy/decide`, signed and valid for 7 days, and land as actor `hook:ntfy`.

Pushes go out when a `proposal`, `decision`, `blocker` or `pr_ready` item is created and when a question is answered. Decisions themselves don't push. Links in pushes use `PUBLIC_URL`.

**Per-person topics.** Each teammate sets their own topic (and display name) in **Settings → Notifications**; it's stored on their `users` row, and only its owner sees it (not even admins). Viewers get no ntfy pushes, since the buttons decide. An item assigned to someone pushes to their topic alone (and reassigning an open item pushes it to the new assignee); an unassigned item, or one whose assignee has no topic, pushes to every person's topic plus `NTFY_TOPIC`. The assignee UI (Inbox filter, the item page's control) appears once someone is assigned or has saved their notification settings. `NTFY_TOPIC` is optional once people have topics, and until anyone sets one it works exactly as before. The approve/reject buttons are the same signed links on every topic, and a tap still lands as `hook:ntfy`.

## Web Push

Native notifications to the installed home-screen app (iPhone and iPad on iOS/iPadOS 16.4+, Android and desktop Chrome, Edge, Firefox, Safari), alongside ntfy. Nothing to set up on the server: each person turns it on per device in **Settings → Notifications → Enable notifications on this device**, then **Send test notification**. Until someone does, nothing is sent.

**How it works.** The service worker (`public/sw.js`) subscribes the device with the browser's push service (Apple, Google, Mozilla or Microsoft, whichever the browser uses) and the page stores that subscription with `POST /api/push/subscribe` under the person's email (`push_subscriptions`, migration 0004). The same events that push to ntfy (a new proposal, decision, blocker or PR-ready item, an agent's answer, a reassign) push to the assignee's devices, or to everyone's when the item is unassigned or the assignee has no device, the same rule as per-person ntfy topics except that viewers get Web Push too (it has no decide buttons). A tap opens the item; there are no approve/reject buttons on these notifications. A push service answering 404/410 (the person turned notifications off, uninstalled the app, or the subscription expired) deletes the subscription, as does a 403 that says the subscription was made with another VAPID key; other failures are counted in `fail_count` and logged, and 10 in a row delete it.

**Push services.** The Worker POSTs each push to the endpoint the browser handed out, so it only stores endpoints on the browsers' push services: `https`, port 443, a host under one of

| Host suffix | Browsers | Source |
|---|---|---|
| `push.apple.com` | Safari (macOS 13+, iOS/iPadOS 16.4+ home-screen apps) | Apple: "If your network infrastructure limits which URLs your server can access, allow access for `https://*.push.apple.com`" ([Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers); also [Meet Web Push, WebKit](https://webkit.org/blog/12945/meet-web-push/)) |
| `push.services.mozilla.com` | Firefox (`updates.push.services.mozilla.com`) | [autopush HTTP API](https://autopush.readthedocs.io/en/latest/http.html) |
| `notify.windows.com` | Edge on Windows (WNS, `wns2-*.notify.windows.com`) | [WNS request and response headers](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/push-request-response-headers) |
| `googleapis.com`, `google.com` | Chrome, and Chromium browsers that use FCM (Opera, Brave, Vivaldi) | `fcm.googleapis.com` (and the older `android.googleapis.com`): [Chrome, Web Push interoperability wins](https://developer.chrome.com/blog/web-push-interop-wins); `*.google.com` (`jmt17.google.com/fcm/send/…`): what current Chrome hands out, seen in practice, not in Google's docs |

A browser or self-hosted push service outside that list needs `PUSH_ENDPOINT_HOSTS` (comma-separated host suffixes, each also allowing its subdomains, e.g. `push.example.org`). Until it is set, enabling notifications there fails with "endpoint must be on a browser push service host". Whatever the list says, `localhost`, single-label names, `.localhost`, `.internal`, `.local`, `.lan`, `.home.arpa` and `.corp` names, IP literals and other ports are refused, and a push request never follows a redirect (a 3xx counts as a failure). Hosts are compared lower-cased and without a trailing dot. Stored subscriptions are checked again before every push and by the daily cron: one that no longer passes (stored before this list existed, or under a `PUSH_ENDPOINT_HOSTS` entry since removed) is deleted unpushed, and the log names its host only.

**A device on a shared browser.** An endpoint belongs to the account that stored it; someone else signed in on that browser gets 409 from `POST /api/push/subscribe` rather than taking it over. Settings → Notifications shows "Another account's" and **Enable** makes a new subscription for the person signed in; the old one stops working, and is deleted on its next push.

**Failures.** Push services answer 404 or 410 for a subscription that is gone ([RFC 8030 §7.3](https://www.rfc-editor.org/rfc/rfc8030#section-7.3): 404 for an expired subscription; [web.dev](https://web.dev/articles/push-notifications-common-issues-and-reporting-bugs): 404 and 410 "should be removed from your back end"; Apple: 410 "The device token has expired"; WNS: "Do not send further notifications to this channel"). A subscription made with a different VAPID key can never work again: [RFC 8292 §4.2](https://www.rfc-editor.org/rfc/rfc8292#section-4.2) has the push service reject it, "a 403 (Forbidden) status code might be used"; Apple answers 403 with reason `VapidPkHashMismatch` (Apple doc above), FCM 403 "the key in the authorization header does not correspond to the sender ID used to subscribe this user" (as FCM sends it; not in Google's docs), Mozilla 404 (web.dev). Those are deleted. Any other 403 (Apple's `BadJwtToken`, say) points at this deployment's VAPID setup rather than the device, so it only counts toward the 10 failures.

**Keys.** Push services only accept messages signed with the VAPID key the device subscribed with. With no secrets set, the Worker generates a P-256 key pair on first use and keeps it in D1 (`vapid_keys`, one row; no API returns the private half), which is enough for a single deployment. To manage the key as secrets instead, set both `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (base64url: the raw 65-byte public point and the 32-byte private scalar, the format `npx web-push generate-vapid-keys` prints). Either:

- **Keep the generated key** (devices stay subscribed): read it with `npx wrangler d1 execute agent-inbox --remote --command "SELECT public_key, private_key FROM vapid_keys"` and put those two values in the secrets. Then delete the row if you like (`DELETE FROM vapid_keys`); the secrets take precedence either way.
- **Use a new key**: generate one without extra tools,

  ```bash
  openssl ecparam -name prime256v1 -genkey -noout -out vapid.pem
  openssl ec -in vapid.pem -pubout -outform DER | tail -c 65 | base64 | tr '/+' '_-' | tr -d '=\n'          # VAPID_PUBLIC_KEY
  openssl ec -in vapid.pem -outform DER | tail -c +8 | head -c 32 | base64 | tr '/+' '_-' | tr -d '=\n'   # VAPID_PRIVATE_KEY
  rm vapid.pem
  ```

  and set both. **Changing the key invalidates every existing subscription**: each device shows "Needs re-enabling" in Settings until its owner taps Enable again. Setting only one of the two secrets makes `/api/push/key` answer 503 and item pushes log an error, so set them together. `VAPID_SUBJECT` (a `mailto:` or `https:` contact the push services can reach you at) defaults to `PUBLIC_URL`.

**iPhone and iPad.** Web Push needs iOS/iPadOS 16.4 or later and works only in the installed app, not in a Safari tab: open the site in Safari, Share → **Add to Home Screen**, open **Inbox** from the Home Screen, sign in through Access, then Settings → Notifications → Enable. Settings says "Add to Home Screen first" in a Safari tab. iOS asks for permission once; if it was refused, allow it in the iOS Settings app → Notifications → Inbox. Focus modes and notification summaries apply as for any app.

**Privacy.** Each payload (`{title, body, url, tag}`: the item's title and question, at most 3 KB) is encrypted to the device's own key (RFC 8291) before it leaves the Worker, so the push service relays it without being able to read it; ntfy.sh, by contrast, sees every title and question. The push service still learns when a device gets a push and from which server.

**Service worker and Access.** The service worker caches only this build's files (the app shell, `/assets/*`, the manifest and icons) for an offline start, and never intercepts `/api`, `/agent`, `/hooks` or `/cdn-cgi`. Page loads go to the network first and Cloudflare Access's sign-in redirects pass straight through; the cached shell is only used when there is no network at all, and then the page shows an offline banner. Each deploy gets a new cache (named after a hash of the build), and the old one is dropped when the new service worker activates; an open page keeps its code until it is reloaded or relaunched. Installing copies the hashed `/assets/*` files the previous cache already holds and revalidates the shell, manifest and icons (a 304 when unchanged), so a deploy costs a device only the files that changed. Only the latin subsets of Geist and Geist Mono are bundled (`src/fonts.css`); other scripts in pasted content render in the system font.

## GitHub webhook

In each repo whose PRs the inbox links (Settings → Webhooks → Add webhook):

- Payload URL `https://<your-host>/hooks/github`, content type `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET` (one secret for every repo's webhook)
- SSL verification on
- Events: "Let me select individual events", then tick **Pull requests** and **Pull request reviews** only. Untick **Pushes**, which is ticked by default. Don't add check suites or check runs: the hook ignores them, and they are the noisiest events.

Items whose `links`/`evidence` contain the PR URL, and managers whose `pr.url` is it, get `pr_state`. A merged PR archives its open `pr_ready` item, and a merged or closed one archives open items posted with `close_on_pr`. Merged and closed stick: a late review or a redelivered event doesn't move them back.

Review routines' PRs (the Reviews tab) get the same deliveries between runs ([reviews.md](reviews.md#github-hook)). New commits (`synchronize`), reopen, draft and ready-for-review, submitted reviews, and merge or close all land in the PR's `gh` facts. The PR pane's timeline then shows each review ("sam approved") and the newest push. A merged or closed PR leaves the list until a reopen. Each routine that changed logs one change row, so an open tab refreshes live.

To check a new webhook, open it in GitHub (Settings → Webhooks → the webhook → **Recent Deliveries**). The first delivery is a `ping`, which the hook answers with 202 `{"ignored":true}`. A 401 there means the secret differs from `GITHUB_WEBHOOK_SECRET`, and a 503 means the secret isn't set on the Worker. A 302 or an HTML page means Cloudflare Access is in front of `/hooks`. After the next PR event, its delivery shows 200 with `{"updated":[...]}`. **Redeliver** replays one, which is safe: the hook treats a replay as a no-op.

## Import from the artifact

For moving over from the claude.ai Artifact inbox of the `orchestration-manager` skill (background: [evaluation.md](evaluation.md)).

1. From the orchestrator session, export each collection with `ArtifactData` `list` and `out_dir` into one directory (`items`, `orchestrators`, `meta`, and `items/<id>/qa` for each item with questions). That writes `<dir>/<collection>/<doc_id>.json`. A single JSON file works too: `{items: [...], orchestrators: [...], meta: [...], "items/<id>/qa": [...]}`, the same under `collections`, or `[{collection, id, data, version}]`.
2. Dry run, then write:

   ```bash
   node scripts/import-artifact.mjs ~/claude-orchestrator/inbox-export --dry-run > /tmp/import.sql
   node scripts/import-artifact.mjs ~/claude-orchestrator/inbox-export --remote
   ```

The importer keeps versions and timestamps, sets `updated_by = import:artifact`, skips docs that already exist (`--replace` overwrites), skips `meta/lease` (`--with-lease` keeps it), builds `meta/schedule` from `meta/manager`'s `work_hours`/`timezone`/intervals when the export has none, and reports invalid ids and collections it skipped. `--remote` is never the default.

## Costs and limits

Sized for one person and ~10 agents. Everything fits Cloudflare's free allowances; on the Workers Paid plan the marginal cost is about $0.

| Resource | Use | Allowance (free / paid) |
|---|---|---|
| Worker requests | One open UI tab long-polls `/api/changes` every ~20 s (~4k/day); the orchestrator's `wait` every ~25 s (~3.5k/day); agents' writes are tens to hundreds a day | 100k/day free · 10M/month in the $5 plan |
| Worker CPU | Long-polls sleep between checks, and waiting isn't billed; a request costs a few ms of CPU | 10 ms/request free · 30 s paid |
| D1 reads | Each long-poll re-checks the log by primary key every 1.5 s (≈17 small queries per request, rows read ≈ new changes); the UI's `/api/state?archived=100` (on a first open, or a delta reset) reads every open/decided/processing item, at most 100 archived ones and an index count of the rest, while each live change is a `/api/state/delta` of ~20 rows, and Load older or a History search reads up to 200 more per request | 5M rows/day free · 25B/month paid |
| D1 writes | Each write is the doc row plus its change-log row; the daily prune deletes about a day's worth of change-log rows (at most 5,000 per run) | 100k rows/day free · 50M/month paid |
| D1 storage | KBs per item | 5 GB |

Limits worth knowing:

- The UI's `/api/state` (fetched on a first open; after that each change is a `GET /api/state/delta` of a few docs, ~1 KB gzipped against ~72 KB) holds the 100 most recently updated archived items, not all of them, so its payload stays flat as history grows; History loads older pages on demand and searches the rest on the server. Without `?archived=` (the CLI's `state`, the orchestrator) it still returns every item, archived ones included, so that payload grows with history.
- The `changes` table keeps 30 days. A Cron Trigger (`triggers.crons` in `wrangler.jsonc`, daily at 04:17 UTC) deletes older rows in batches of 500, at most 5,000 per run, so a larger backlog drains over several days. Set the `CHANGES_RETENTION_DAYS` var to keep more (or less, down to 7); any other value makes the run throw and delete nothing, and the error shows in the Worker's logs. Each run logs how many rows it deleted. The same run first deletes spent snoozes (past their time, or on an item no longer open), whatever that setting holds, and review runs and events older than `REVIEWS_RETENTION_DAYS` (default 90, at least 14; any other value fails the run, after the change log was still pruned) plus PRs gone from a routine's report for over 30 days ([reviews.md](reviews.md) "Retention"). Pruned history is gone, for manager tokens too. `wrangler deploy` registers the trigger.
- ntfy.sh topics are public by name: the topic must be long and random, and push text (titles, questions) passes through ntfy.sh. Web Push payloads are encrypted to each device instead.
- Web Push sends one request per subscribed device per push, from `waitUntil`; a handful of devices is nothing next to the long-polls.
- Tokens are bearer secrets on the box. Scopes prevent mistakes, not a hostile process running as the same user.
- Long-polls are capped at 25 s per request; `wait` chains them, so wake latency is ~1.5 s.
