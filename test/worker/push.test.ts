// Web Push: the VAPID key endpoint, subscriptions, the test push, and which
// devices an item's push reaches (the same rule as per-person ntfy topics).
// Own file: subscriptions and the generated key are per-D1.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index.ts";
import { b64urlDecode } from "../../worker/webpush.ts";
import { mintToken, setPeople, uid } from "./helpers.ts";
import { decryptPayload, newSubscriptionKeys } from "./webpush-helpers.ts";

interface Sent {
  url: string;
  headers: Headers;
  body: Uint8Array;
  redirect: string | undefined;
}
let pushed: Sent[] = [];
let ntfy: { topic: string; title: string }[] = [];
// Push service answers by endpoint (a status, or a status and body); 201 unless set.
let answer: Record<string, number | { status: number; body: string }> = {};

beforeEach(() => {
  pushed = [];
  ntfy = [];
  answer = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (new URL(req.url).hostname === "ntfy.sh") {
      ntfy.push(await req.json());
      return new Response("{}");
    }
    pushed.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()), redirect: init?.redirect });
    const a = answer[req.url] ?? 201;
    return typeof a === "number" ? new Response(null, { status: a }) : new Response(a.body, { status: a.status });
  });
});
afterEach(() => vi.restoreAllMocks());

async function send(as: string | { token: string }, method: string, path: string, body?: unknown, vars: Record<string, string | undefined> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const human = typeof as === "string";
  if (!human) headers.Authorization = `Bearer ${as.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://${human ? "localhost" : "inbox.test"}${human ? "" : "/agent"}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, ...(human ? { DEV_USER_EMAIL: as } : {}), ...vars },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

interface Device {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  priv: string;
}
async function subscribe(email: string): Promise<Device> {
  const k = await newSubscriptionKeys();
  const d = { endpoint: `https://fcm.googleapis.com/fcm/send/${uid("ep")}`, keys: { p256dh: k.p256dh, auth: k.auth }, priv: k.priv };
  const r = await send(email, "POST", "/api/push/subscribe", { endpoint: d.endpoint, expirationTime: null, keys: d.keys });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return d;
}
async function payload(d: Device): Promise<any> {
  const msg = pushed.find((p) => p.url === d.endpoint);
  expect(msg, `nothing pushed to ${d.endpoint}`).toBeDefined();
  return JSON.parse(await decryptPayload(msg!.body, d.keys.p256dh, d.priv, d.keys.auth));
}
const row = (endpoint: string) =>
  env.DB.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first<Record<string, any>>();
const reached = (...ds: Device[]) => expect(pushed.map((p) => p.url).sort()).toEqual(ds.map((d) => d.endpoint).sort());

describe("GET /api/push/key", () => {
  it("generates a P-256 key once, keeps it in D1, and returns the same one after", async () => {
    const a = await send("you@test", "GET", "/api/push/key");
    expect(a.status).toBe(200);
    const raw = b64urlDecode(a.body.key);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    expect((await send("you@test", "GET", "/api/push/key")).body.key).toBe(a.body.key);
    const stored = await env.DB.prepare("SELECT public_key FROM vapid_keys").all();
    expect(stored.results).toEqual([{ public_key: a.body.key }]);
  });

  it("uses VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when both are set", async () => {
    const vars = {
      VAPID_PUBLIC_KEY: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    };
    expect((await send("you@test", "GET", "/api/push/key", undefined, vars)).body).toEqual({ key: vars.VAPID_PUBLIC_KEY });
  });

  it("refuses to run on half a key pair from secrets", async () => {
    const r = await send("you@test", "GET", "/api/push/key", undefined, { VAPID_PUBLIC_KEY: "BP4z" });
    expect(r).toMatchObject({ status: 503, body: { error: "unavailable" } });
  });

  it("is for humans only: manager and orchestrator tokens get 403", async () => {
    for (const t of [await mintToken("manager", undefined, uid("m")), await mintToken("orchestrator", "O1", uid("o"))]) {
      expect((await send({ token: t.secret }, "GET", "/api/push/key")).status).toBe(403);
      expect((await send({ token: t.secret }, "POST", "/api/push/subscribe", {})).status).toBe(403);
      expect((await send({ token: t.secret }, "POST", "/api/push/test", {})).status).toBe(403);
    }
  });
});

describe("subscriptions", () => {
  it("stores the caller's subscription under their lowercased email", async () => {
    const d = await subscribe("Alice@Example.com");
    expect(await row(d.endpoint)).toMatchObject({
      email: "alice@example.com",
      p256dh: d.keys.p256dh,
      auth: d.keys.auth,
      fail_count: 0,
      last_ok_at: null,
    });
  });

  it("the same person re-subscribing an endpoint updates its keys in place and clears its failures", async () => {
    const d = await subscribe("alice@example.com");
    await env.DB.prepare("UPDATE push_subscriptions SET fail_count = 3 WHERE endpoint = ?").bind(d.endpoint).run();
    const before = await row(d.endpoint);
    const k = await newSubscriptionKeys();
    const r = await send("Alice@Example.com", "POST", "/api/push/subscribe", { endpoint: d.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } });
    expect(r.status).toBe(201);
    expect(await row(d.endpoint)).toMatchObject({ id: before!.id, created_at: before!.created_at, email: "alice@example.com", p256dh: k.p256dh, fail_count: 0 });
  });

  it("someone else submitting an endpoint that is already stored gets 409, and the row stays its owner's", async () => {
    const d = await subscribe("alice@example.com");
    const before = await row(d.endpoint);
    const k = await newSubscriptionKeys();
    const r = await send("bob@example.com", "POST", "/api/push/subscribe", { endpoint: d.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } });
    expect(r).toMatchObject({ status: 409, body: { error: "endpoint_taken" } });
    expect(await row(d.endpoint)).toEqual(before);
  });

  it.each([
    ["no endpoint", { keys: {} }],
    ["an http endpoint", { endpoint: "http://fcm.googleapis.com/x" }],
    ["an endpoint on an IP address", { endpoint: "https://10.0.0.1/x" }],
    ["an endpoint on localhost", { endpoint: "https://localhost:8443/x" }],
    ["localhost with a trailing dot", { endpoint: "https://localhost./x" }],
    ["upper-case localhost with a trailing dot and port", { endpoint: "https://LOCALHOST.:443/x" }],
    ["a .localhost name", { endpoint: "https://push.localhost/x" }],
    ["a single-label host", { endpoint: "https://push/x" }],
    ["an .internal host", { endpoint: "https://foo.internal/x" }],
    ["a .local host", { endpoint: "https://printer.local/x" }],
    ["a .lan host", { endpoint: "https://router.lan/x" }],
    ["a .home.arpa host", { endpoint: "https://nas.home.arpa/x" }],
    ["a .corp host", { endpoint: "https://intranet.corp/x" }],
    ["an IPv4 literal in hex", { endpoint: "https://0x7f.1/x" }],
    ["an IPv4 literal as one number", { endpoint: "https://2130706433/x" }],
    ["an IPv6 literal", { endpoint: "https://[::1]/x" }],
    ["a wildcard-DNS name for a private IP", { endpoint: "https://127.0.0.1.nip.io/x" }],
    ["a host that isn't a push service", { endpoint: "https://evil.workers.dev/x" }],
    ["a look-alike of a push service", { endpoint: "https://fcm.googleapis.com.evil.dev/x" }],
    ["a suffix without the label boundary", { endpoint: "https://evilgoogle.com/x" }],
    ["a push service host on another port", { endpoint: "https://fcm.googleapis.com:8443/x" }],
    ["an endpoint with credentials", { endpoint: "https://user:pw@fcm.googleapis.com/x" }],
    ["a bad p256dh", { p256dh: "AAAA" }],
    ["a bad auth", { auth: "not base64url!" }],
  ])("rejects %s with 400", async (_name, patch: Record<string, unknown>) => {
    const k = await newSubscriptionKeys();
    const sub: Record<string, any> = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: k.p256dh, auth: k.auth } };
    if ("endpoint" in patch) sub.endpoint = patch.endpoint;
    if ("keys" in patch) sub.keys = patch.keys;
    if ("p256dh" in patch) sub.keys.p256dh = patch.p256dh;
    if ("auth" in patch) sub.keys.auth = patch.auth;
    expect((await send("you@test", "POST", "/api/push/subscribe", sub)).status).toBe(400);
  });

  it("accepts the push services browsers use", async () => {
    const k = await newSubscriptionKeys();
    for (const endpoint of [
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
      "https://fcm.googleapis.com/fcm/send/abc:def",
      // What current Chrome hands out: not under fcm.googleapis.com, hence google.com in the allowlist.
      "https://jmt17.google.com/fcm/send/dMb4ilgvWuw:APA91bF",
    ]) {
      const r = await send("you@test", "POST", "/api/push/subscribe", { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } });
      expect(r.status, endpoint).toBe(201);
    }
  });

  it("stores a push service endpoint normalized: lower-case host, no trailing dot, no default port", async () => {
    const k = await newSubscriptionKeys();
    const r = await send("you@test", "POST", "/api/push/subscribe", { endpoint: "https://FCM.GoogleAPIs.com.:443/fcm/send/Norm", keys: { p256dh: k.p256dh, auth: k.auth } });
    expect(r.status).toBe(201);
    expect(await row("https://fcm.googleapis.com/fcm/send/Norm")).toMatchObject({ email: "you@test" });
    expect((await send("you@test", "DELETE", "/api/push/subscribe", { endpoint: "https://fcm.googleapis.com./fcm/send/Norm" })).body).toEqual({ ok: true, removed: 1 });
  });

  it("PUSH_ENDPOINT_HOSTS adds push service hosts (and their subdomains), still https on 443 only", async () => {
    const k = await newSubscriptionKeys();
    const vars = { PUSH_ENDPOINT_HOSTS: " push.example.org , *.relay.example.net " };
    const sub = (endpoint: string, v: Record<string, string> = vars) =>
      send("you@test", "POST", "/api/push/subscribe", { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } }, v);
    expect((await sub("https://push.example.org/a")).status).toBe(201);
    expect((await sub("https://eu.push.example.org/a")).status).toBe(201);
    expect((await sub("https://a.relay.example.net/a")).status).toBe(201);
    expect((await sub("https://push.example.org/b", {})).status).toBe(400);
    expect((await sub("https://push.example.org:8443/a")).status).toBe(400);
    expect((await sub("https://example.org/a")).status).toBe(400);
    // The built-in services stay allowed with an override set.
    expect((await sub("https://fcm.googleapis.com/fcm/send/ovr")).status).toBe(201);
  });

  it("DELETE removes the caller's own subscription by endpoint, never someone else's", async () => {
    const mine = await subscribe("alice@example.com");
    const theirs = await subscribe("bob@example.com");
    expect((await send("alice@example.com", "DELETE", "/api/push/subscribe", { endpoint: theirs.endpoint })).body).toEqual({ ok: true, removed: 0 });
    expect(await row(theirs.endpoint)).not.toBeNull();
    expect((await send("alice@example.com", "DELETE", "/api/push/subscribe", { endpoint: mine.endpoint })).body).toEqual({ ok: true, removed: 1 });
    expect(await row(mine.endpoint)).toBeNull();
  });
});

describe("POST /api/push/test", () => {
  beforeEach(() => env.DB.prepare("DELETE FROM push_subscriptions").run());

  it("pushes an encrypted test message to the caller's own devices only, with VAPID headers", async () => {
    const mine = await subscribe("alice@example.com");
    await subscribe("bob@example.com");
    const r = await send("alice@example.com", "POST", "/api/push/test", {});
    expect(r).toMatchObject({ status: 200, body: { sent: 1, failed: 0, removed: 0 } });
    reached(mine);
    const h = pushed[0].headers;
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(Number(h.get("ttl"))).toBeGreaterThan(0);
    const key = (await send("you@test", "GET", "/api/push/key")).body.key;
    expect(h.get("authorization")).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${key}$`));
    expect(await payload(mine)).toEqual({ title: "Test notification", body: expect.any(String), url: "/#settings", tag: "test" });
    expect((await row(mine.endpoint))!.last_ok_at).not.toBeNull();
  });

  it("deletes subscriptions the push service says are gone (404, 410) and counts other failures", async () => {
    const gone = await subscribe("alice@example.com");
    const missing = await subscribe("alice@example.com");
    const flaky = await subscribe("alice@example.com");
    answer[gone.endpoint] = 410;
    answer[missing.endpoint] = 404;
    answer[flaky.endpoint] = 500;
    const r = await send("alice@example.com", "POST", "/api/push/test", {});
    expect(r.body).toEqual({ sent: 0, failed: 1, removed: 2 });
    expect(await row(gone.endpoint)).toBeNull();
    expect(await row(missing.endpoint)).toBeNull();
    expect((await row(flaky.endpoint))!.fail_count).toBe(1);
    await send("alice@example.com", "POST", "/api/push/test", {});
    expect((await row(flaky.endpoint))!.fail_count).toBe(2);
    delete answer[flaky.endpoint];
    await send("alice@example.com", "POST", "/api/push/test", {});
    expect(await row(flaky.endpoint)).toMatchObject({ fail_count: 0, last_ok_at: expect.any(String) });
  });

  it("doesn't follow redirects: a 3xx from a push service counts as a failure", async () => {
    const d = await subscribe("alice@example.com");
    answer[d.endpoint] = 307;
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect(pushed.map((p) => p.redirect)).toEqual(["manual"]);
    expect((await row(d.endpoint))!.fail_count).toBe(1);
  });

  it("deletes a subscription after 10 failures in a row", async () => {
    const d = await subscribe("alice@example.com");
    await env.DB.prepare("UPDATE push_subscriptions SET fail_count = 8 WHERE endpoint = ?").bind(d.endpoint).run();
    answer[d.endpoint] = 500;
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect((await row(d.endpoint))!.fail_count).toBe(9);
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(await row(d.endpoint)).toBeNull();
  });

  it("a 403 saying the subscription was made with another VAPID key deletes it; any other 403 only counts", async () => {
    const apple = await subscribe("alice@example.com");
    const fcm = await subscribe("alice@example.com");
    const badJwt = await subscribe("alice@example.com");
    answer[apple.endpoint] = { status: 403, body: JSON.stringify({ reason: "VapidPkHashMismatch" }) };
    answer[fcm.endpoint] = {
      status: 403,
      body: "the key in the authorization header does not correspond to the sender ID used to subscribe this user. Please ensure you are using the correct sender ID and server Key from the Firebase console.",
    };
    answer[badJwt.endpoint] = { status: 403, body: JSON.stringify({ reason: "BadJwtToken" }) };
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 0, failed: 1, removed: 2 });
    expect(await row(apple.endpoint)).toBeNull();
    expect(await row(fcm.endpoint)).toBeNull();
    expect((await row(badJwt.endpoint))!.fail_count).toBe(1);
  });

  it("a network error counts as a failure and doesn't fail the request", async () => {
    const d = await subscribe("alice@example.com");
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("network down"));
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect((await row(d.endpoint))!.fail_count).toBe(1);
  });
});

describe("item pushes", () => {
  let alice: Device, alice2: Device, bob: Device;
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
    alice = await subscribe("alice@example.com");
    alice2 = await subscribe("alice@example.com");
    bob = await subscribe("bob@example.com");
    pushed = [];
  });
  const put = (data: Record<string, unknown>, id = uid("i")) =>
    send("you@test", "PUT", `/api/items/${id}`, { data: { type: "proposal", title: "Do X", ...data } });

  it("an unassigned ask reaches every device, with a small payload linking to the item", async () => {
    const r = await put({ question: "Ship it?" });
    reached(alice, alice2, bob);
    expect(await payload(bob)).toEqual({ title: "Do X", body: "Ship it?", url: `/#item.${r.body.id}`, tag: r.body.id });
  });

  it("an assigned ask reaches only the assignee's devices", async () => {
    await put({ assignee: "Alice@example.com" });
    reached(alice, alice2);
  });

  it("an assignee with no devices falls back to everyone's", async () => {
    await put({ assignee: "carol@example.com" });
    reached(alice, alice2, bob);
  });

  it("items that aren't asks don't push", async () => {
    await put({ type: "info" });
    expect(pushed).toEqual([]);
  });

  it("a long question is cut so the payload stays under 3 KB", async () => {
    await put({ title: "T".repeat(2000), question: "Q".repeat(20000) });
    const p = await payload(bob);
    expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(3072);
    expect(p.body.endsWith("…")).toBe(true);
  });

  it("answers follow the item's assignee", async () => {
    const id = uid("i");
    await put({ type: "info", title: "q", assignee: "bob@example.com" }, id);
    const manager = (await mintToken("manager", undefined, uid("mgr"))).secret;
    expect((await send({ token: manager }, "POST", `/api/items/${id}/qa`, { text: "because" })).status).toBe(201);
    reached(bob);
    expect(await payload(bob)).toEqual({ title: "Answer: q", body: "because", url: `/#item.${id}`, tag: id });
  });

  it("reassigning an open ask pushes to the new assignee only; assigning yourself doesn't", async () => {
    const id = (await send("you@test", "PUT", `/api/items/${uid("i")}`, { data: { type: "proposal", title: "Do X", assignee: "carol@example.com" } })).body.id;
    pushed = [];
    await send("you@test", "PATCH", `/api/items/${id}`, { data: { assignee: "bob@example.com" } });
    reached(bob);
    expect((await payload(bob)).title).toBe("Assigned to you: Do X");
    pushed = [];
    await send("alice@example.com", "PATCH", `/api/items/${id}`, { data: { assignee: "alice@example.com" } });
    expect(pushed).toEqual([]);
  });

  it("ntfy keeps working alongside, unchanged", async () => {
    await setPeople({ "alice@example.com": { ntfy_topic: "alice-topic" } });
    await send("you@test", "PUT", `/api/items/${uid("i")}`, { data: { type: "proposal", title: "Do X", assignee: "alice@example.com" } }, { NTFY_TOPIC: "global" });
    expect(ntfy.map((m) => m.topic)).toEqual(["alice-topic"]);
    reached(alice, alice2);
  });

  it("a failing push service never fails the write", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("down"));
    expect((await put({})).status).toBe(201);
  });
});

// Rows stored before the allowlist (PR #35), or allowed by a PUSH_ENDPOINT_HOSTS
// entry since removed: every send and the daily cron check them again.
describe("stored endpoints that no longer validate", () => {
  const EVIL = "https://evil.workers.dev/x";
  let logged: string[] = [];
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
    logged = [];
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
  });
  // Straight into D1, as the subscribe route would refuse it now.
  async function legacy(email: string, endpoint: string): Promise<Device> {
    const k = await newSubscriptionKeys();
    await env.DB.prepare("INSERT INTO push_subscriptions (email, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(email, endpoint, k.p256dh, k.auth, new Date().toISOString())
      .run();
    return { endpoint, keys: { p256dh: k.p256dh, auth: k.auth }, priv: k.priv };
  }
  const runCron = (vars: Record<string, string> = {}) =>
    worker.scheduled(createScheduledController({ scheduledTime: Date.parse("2030-06-01T04:17:00Z"), cron: "17 4 * * *" }), { ...env, ...vars });

  it("a send skips a non-allowlisted endpoint, deletes it, and logs its host only", async () => {
    await legacy("alice@example.com", EVIL);
    const good = await subscribe("alice@example.com");
    const r = await send("alice@example.com", "POST", "/api/push/test", {});
    expect(r.body).toEqual({ sent: 1, failed: 0, removed: 1 });
    reached(good);
    expect(await row(EVIL)).toBeNull();
    expect(await row(good.endpoint)).not.toBeNull();
    expect(logged.filter((l) => l.includes("evil.workers.dev"))).toHaveLength(1);
    expect(logged.join("\n")).not.toContain(EVIL);
  });

  it("an item push to everyone skips and deletes it too, even when it was the only device", async () => {
    await legacy("bob@example.com", EVIL);
    expect((await send("you@test", "PUT", `/api/items/${uid("i")}`, { data: { type: "proposal", title: "Do X" } })).status).toBe(201);
    expect(pushed).toEqual([]);
    expect(await row(EVIL)).toBeNull();
  });

  it("a send keeps an allowlisted endpoint stored before normalization", async () => {
    const d = await legacy("alice@example.com", "https://FCM.GoogleAPIs.com./fcm/send/Legacy");
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(pushed).toHaveLength(1);
    expect(await row(d.endpoint)).not.toBeNull();
  });

  it("a send respects PUSH_ENDPOINT_HOSTS: pushed while listed, deleted once it isn't", async () => {
    const vars = { PUSH_ENDPOINT_HOSTS: "push.example.org" };
    const d = await legacy("alice@example.com", "https://eu.push.example.org/a");
    expect((await send("alice@example.com", "POST", "/api/push/test", {}, vars)).body).toEqual({ sent: 1, failed: 0, removed: 0 });
    reached(d);
    pushed = [];
    expect((await send("alice@example.com", "POST", "/api/push/test", {})).body).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(pushed).toEqual([]);
    expect(await row(d.endpoint)).toBeNull();
  });

  it("the daily cron deletes non-allowlisted endpoints and leaves allowlisted ones alone, without pushing", async () => {
    await legacy("alice@example.com", EVIL);
    const good = await subscribe("alice@example.com");
    const old = await legacy("bob@example.com", "https://Web.Push.Apple.com./QGuQ");
    await runCron();
    expect(await row(EVIL)).toBeNull();
    expect(await row(good.endpoint)).not.toBeNull();
    expect(await row(old.endpoint)).not.toBeNull();
    expect(pushed).toEqual([]);
    expect(logged.filter((l) => l.includes("evil.workers.dev"))).toHaveLength(1);
    expect(logged.join("\n")).not.toContain(EVIL);
  });

  it("the daily cron respects PUSH_ENDPOINT_HOSTS", async () => {
    const d = await legacy("alice@example.com", "https://eu.push.example.org/a");
    await runCron({ PUSH_ENDPOINT_HOSTS: "push.example.org" });
    expect(await row(d.endpoint)).not.toBeNull();
    await runCron();
    expect(await row(d.endpoint)).toBeNull();
  });
});
