// agent-inbox Worker: /api (browser, Access JWT or bearer), /agent/api (the
// same routes, bearer only), /hooks (signed webhooks), and the built UI for
// everything else. See docs/api.md for the contract.

import { authenticate, checkCsrf } from "./auth.ts";
import type { Env } from "./env.ts";
import { githubHook } from "./hooks/github.ts";
import { ntfyDecide } from "./hooks/ntfy.ts";
import { errorResponse, json, notFound } from "./http.ts";
import { pruneOnSchedule, prunePins, prunePushSubscriptions, pruneReviews, pruneSnoozes } from "./prune.ts";
import { makeCtx, Router } from "./router.ts";
import { batchRoutes } from "./routes/batch.ts";
import { changeRoutes } from "./routes/changes.ts";
import { deltaRoutes } from "./routes/delta.ts";
import { itemRoutes } from "./routes/items.ts";
import { checkLeaseSession, leaseRoutes } from "./routes/lease.ts";
import { metaRoutes } from "./routes/meta.ts";
import { orchestratorRoutes } from "./routes/orchestrators.ts";
import { peopleRoutes } from "./routes/people.ts";
import { pinRoutes } from "./routes/pins.ts";
import { pushRoutes } from "./routes/push.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { stateRoutes } from "./routes/state.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { userRoutes } from "./routes/users.ts";

const api = new Router([
  ...stateRoutes,
  ...deltaRoutes,
  ...itemRoutes,
  ...orchestratorRoutes,
  ...metaRoutes,
  ...leaseRoutes,
  ...peopleRoutes,
  ...pushRoutes,
  ...scheduleRoutes,
  ...changeRoutes,
  ...tokenRoutes,
  ...userRoutes,
  ...batchRoutes,
  ...reviewRoutes,
  ...pinRoutes,
]);

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL, path: string, bearerOnly: boolean) {
  // Authenticate before routing so unknown paths don't reveal what exists.
  const caller = await authenticate(request, env, ctx, { bearerOnly });
  checkCsrf(caller, request, url);
  const m = api.match(request.method, path);
  if (!m || m === "method") throw notFound(`No route ${request.method} /api${path}`);
  const c = makeCtx(request, env, ctx, url, caller, m.params);
  // Opt-in X-Lease-Session check, once per request (a batch included).
  await checkLeaseSession(env.DB, request, path, caller, c.now);
  return m.handler(c);
}

// GET /agent/api/health: the one unauthenticated route (behind the Access bypass for /agent, like the agent API).
// One D1 read, the newest migration applied, so the deploy's smoke test sees the Worker, the database and the
// migrations together. Nothing else: no lease, no counts.
async function health(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
    return json({ ok: true, migration: row?.name ?? null });
  } catch (e) {
    console.error("health", e);
    return json({ ok: false }, 503);
  }
}

async function handleHook(request: Request, env: Env, path: string) {
  if (request.method === "POST" && path === "/hooks/github") return githubHook(request, env);
  if (request.method === "POST" && path === "/hooks/ntfy/decide") return ntfyDecide(request, env);
  throw notFound();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith("/api/")) return await handleApi(request, env, ctx, url, path.slice(4), false);
      if (path === "/agent/api/health" && (request.method === "GET" || request.method === "HEAD")) return await health(env);
      if (path.startsWith("/agent/api/")) return await handleApi(request, env, ctx, url, path.slice(10), true);
      if (path.startsWith("/hooks/")) return await handleHook(request, env, path);
      // /agent/* sits behind the Access bypass: never serve the SPA there.
      if (path === "/agent" || path.startsWith("/agent/")) throw notFound();
    } catch (e) {
      return errorResponse(e);
    }
    return env.ASSETS.fetch(request);
  },

  // The daily Cron Trigger (wrangler.jsonc `triggers.crons`): prune spent
  // snoozes, disallowed push subscriptions and old review runs, pins on
  // things gone (after the reviews, so the PRs they pruned count), then the
  // change log. The reviews and change-log settings may each throw; a bad
  // one fails the run (visibly) after the other prunes have run.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await pruneSnoozes(env.DB, controller.scheduledTime);
    await prunePushSubscriptions(env);
    let reviewsError: unknown = null;
    try {
      await pruneReviews(env.DB, controller.scheduledTime, env.REVIEWS_RETENTION_DAYS);
    } catch (e) {
      reviewsError = e;
    }
    await prunePins(env.DB);
    await pruneOnSchedule(env.DB, controller.scheduledTime, env.CHANGES_RETENTION_DAYS);
    if (reviewsError) throw reviewsError;
  },
} satisfies ExportedHandler<Env>;
