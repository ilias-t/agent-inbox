// Web Push for humans: the VAPID public key a browser subscribes with, the
// caller's own subscriptions, and a test push to their devices. Tokens get
// 403 on all of it: a device belongs to a person.

import { requireHuman } from "../auth.ts";
import type { Env } from "../env.ts";
import { sendTest, vapidKeys } from "../hooks/webpush.ts";
import { badRequest, HttpError, isObject, json } from "../http.ts";
import { normalizedEndpoint, pushEndpoint } from "../push-endpoint.ts";
import type { Ctx, Route } from "../router.ts";
import { b64urlDecode } from "../webpush.ts";

function myEmail(c: Ctx): string {
  requireHuman(c.caller);
  return c.caller.principal.kind === "human" ? c.caller.principal.email.toLowerCase() : "";
}

// Subscribe-time half of the endpoint rule (worker/push-endpoint.ts), with
// the reason as a 400. Sends and the daily cron apply the same rule.
function endpointOf(env: Env, body: Record<string, unknown>): string {
  const url = normalizedEndpoint(body.endpoint);
  if (!url || url.protocol !== "https:" || url.username || url.password) throw badRequest("endpoint must be an https URL");
  const ok = pushEndpoint(body.endpoint, env.PUSH_ENDPOINT_HOSTS);
  if (!ok) throw badRequest("endpoint must be on a browser push service host, on port 443");
  return ok.href;
}

function keyOf(keys: Record<string, unknown>, name: string, len: number): string {
  const v = keys[name];
  let ok = false;
  try {
    ok = typeof v === "string" && b64urlDecode(v).length === len;
  } catch {
    /* 400 below */
  }
  if (!ok) throw badRequest(`keys.${name} must be ${len} bytes, base64url`);
  return (v as string).replace(/=+$/, "");
}

async function getKey(c: Ctx): Promise<Response> {
  myEmail(c);
  return json({ key: (await vapidKeys(c.env)).publicKey });
}

// Body: PushSubscription.toJSON(), i.e. {endpoint, expirationTime, keys: {p256dh, auth}}.
// The same person storing an endpoint again (the device re-confirming itself,
// or new keys) updates it in place. An endpoint stored for someone else is 409
// `endpoint_taken`: nobody can prove they hold a device's subscription, so a
// second account can't take one over. That device unsubscribes and subscribes
// afresh instead, which gets it a new endpoint (Settings does this), and the
// old one is deleted when its push service answers 404 or 410.
async function subscribe(c: Ctx): Promise<Response> {
  const email = myEmail(c);
  const body = await c.body();
  const endpoint = endpointOf(c.env, body);
  if (!isObject(body.keys)) throw badRequest("keys must be {p256dh, auth}");
  const p256dh = keyOf(body.keys, "p256dh", 65), auth = keyOf(body.keys, "auth", 16);
  const r = await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (email, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = ?3, auth = ?4, fail_count = 0 WHERE push_subscriptions.email = ?1`,
  )
    .bind(email, endpoint, p256dh, auth, c.now)
    .run();
  if (!r.meta.changes) {
    throw new HttpError(409, "endpoint_taken", "This device's subscription belongs to another account. Unsubscribe it and subscribe again.");
  }
  return json({ ok: true }, 201);
}

async function unsubscribe(c: Ctx): Promise<Response> {
  const email = myEmail(c);
  const endpoint = (await c.body()).endpoint;
  if (typeof endpoint !== "string" || !endpoint) throw badRequest("endpoint is required");
  // Stored endpoints are normalized; a non-URL matches nothing.
  const href = normalizedEndpoint(endpoint)?.href ?? endpoint;
  const r = await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?").bind(href, email).run();
  return json({ ok: true, removed: r.meta.changes ?? 0 });
}

async function test(c: Ctx): Promise<Response> {
  return json(await sendTest(c, myEmail(c)));
}

export const pushRoutes: Route[] = [
  ["GET", "/push/key", getKey],
  ["POST", "/push/subscribe", subscribe],
  ["DELETE", "/push/subscribe", unsubscribe],
  ["POST", "/push/test", test],
];
