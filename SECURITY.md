# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open [a private security advisory](https://github.com/ilias-t/agent-inbox/security/advisories/new) (the repository's **Security** tab → **Report a vulnerability**). Don't open a public issue, pull request or discussion for a suspected vulnerability.

Include what you can of:

- what an attacker can do, and what they need first (a token and its scope, an Access session, a role, network position);
- the steps or a request that reproduces it, against a local `wrangler dev` (see the README's "Try it locally") rather than someone else's deployment;
- the commit you tested.

This is a small project maintained in spare time. Expect an acknowledgement within a week and a fix or a plan once the report is confirmed. We'll credit you in the advisory unless you'd rather not be named.

## Supported versions

Only the latest commit on `main` gets fixes. There are no release branches; self-hosted deployments pick up a fix by redeploying from `main`.

## Scope

In scope: the Worker (`worker/`), the web app (`src/`), the CLI (`cli/`, `bin/`), the scripts under `scripts/`, the database migrations, and the deploy defaults documented in this repository. Examples of what we want to hear about:

- reaching `/api` or `/agent/api` without valid Cloudflare Access credentials or a valid bearer token (the static page and the `/agent/api/health` check are public by design);
- a token acting outside its scope (a manager token touching another manager's items, for instance) or a role doing more than it allows;
- forged or replayed webhook and ntfy action signatures;
- cross-site scripting or Content-Security-Policy bypasses in the web app;
- secrets or tokens leaking into logs, responses or notifications.

Out of scope: weaknesses in Cloudflare, ntfy or GitHub themselves, and a deployment's own configuration (an Access policy that lets everyone in, a leaked token, a public ntfy topic). [docs/deploy.md](docs/deploy.md) describes how to set those up safely.
