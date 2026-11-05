// public/sw.js run against a fake service worker scope: what it intercepts
// (never the API, agent, hook or Access paths), the offline fallback that
// must not swallow Cloudflare Access redirects, the versioned cache, and the
// push / notificationclick handlers.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://inbox.test";

type Handler = (ev: any) => void;

// Response-likes: Node can't build opaqueredirect or "basic" responses itself.
function res(body: string, over: Partial<{ status: number; type: string; redirected: boolean; ok: boolean; ct: string }> = {}) {
  const status = over.status ?? 200;
  return {
    body,
    status,
    ok: over.ok ?? (status >= 200 && status < 300),
    type: over.type ?? "basic",
    redirected: over.redirected ?? false,
    headers: new Headers({ "content-type": over.ct ?? "text/html" }),
    clone() {
      return this;
    },
  };
}
const OPAQUE_REDIRECT = res("", { status: 0, type: "opaqueredirect", ok: false });

function fakeCaches() {
  const stores = new Map<string, Map<string, any>>();
  const key = (r: any) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      put: async (r: any, v: any) => void m.set(key(r), v),
      match: async (r: any) => m.get(key(r)),
    };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    has: async (name: string) => stores.has(name),
  };
}

let handlers: Record<string, Handler>;
let caches: ReturnType<typeof fakeCaches>;
let fetchMock: ReturnType<typeof vi.fn>;
let scope: any;
let windows: any[];

// assets: what the build stamps into ASSETS (vite.config.ts), the hashed /assets/ files to precache.
function load(assets: string[] = []) {
  handlers = {};
  caches = fakeCaches();
  fetchMock = vi.fn();
  windows = [];
  scope = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (t: string, fn: Handler) => (handlers[t] = fn),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
    registration: { showNotification: vi.fn(async () => {}) },
  };
  const src = SRC.replace("/*__SW_ASSETS__*/ []", JSON.stringify(assets));
  new Function("self", "caches", "fetch", src)(scope, caches, fetchMock);
}

// Dispatches an event; resolves with what it responded with (or undefined) once its waitUntil work is done.
async function dispatch(type: string, ev: Record<string, unknown> = {}) {
  let responded: Promise<any> | undefined;
  const waits: Promise<unknown>[] = [];
  handlers[type]({
    ...ev,
    respondWith: (p: any) => (responded = Promise.resolve(p)),
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return { responded: responded !== undefined, response: await responded };
}

const get = (path: string, mode = "cors", origin = ORIGIN) => ({ url: new URL(path, origin).href, method: "GET", mode, headers: new Headers() });
const navigate = (path = "/") => get(path, "navigate");

async function install(responses: Record<string, any> = {}) {
  fetchMock.mockImplementation(async (r: any) => responses[new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname] ?? res("x"));
  await dispatch("install");
  fetchMock.mockReset();
}
const currentCache = (except = "") => [...caches.stores.keys()].find((k) => k.startsWith("agent-inbox-") && k !== except)!;

beforeEach(load);

describe("what the service worker leaves alone", () => {
  it.each(["/api/state", "/api/changes?since=1&wait=20", "/agent/api/me", "/agent", "/hooks/ntfy/decide?x=1", "/cdn-cgi/access/authorized?token=x"])(
    "never intercepts %s, so it is never cached or served from cache",
    async (path) => {
      expect((await dispatch("fetch", { request: get(path) })).responded).toBe(false);
      expect((await dispatch("fetch", { request: navigate(path) })).responded).toBe(false);
    },
  );

  it("leaves other origins (fonts) and non-GET requests to the browser", async () => {
    expect((await dispatch("fetch", { request: get("/css2?family=Geist", "cors", "https://fonts.googleapis.com") })).responded).toBe(false);
    expect((await dispatch("fetch", { request: { ...get("/assets/x.js"), method: "POST" } })).responded).toBe(false);
  });
});

describe("navigations: network first, the cached shell only when offline", () => {
  it("passes the network's answer through, an Access sign-in redirect included", async () => {
    await install();
    fetchMock.mockResolvedValue(OPAQUE_REDIRECT);
    const r = await dispatch("fetch", { request: navigate("/") });
    expect(r.response).toBe(OPAQUE_REDIRECT);
    const fresh = res("<html>new</html>");
    fetchMock.mockResolvedValue(fresh);
    expect((await dispatch("fetch", { request: navigate("/") })).response).toBe(fresh);
  });

  it("passes server errors through rather than hiding them behind the shell", async () => {
    await install();
    const err = res("bad gateway", { status: 502 });
    fetchMock.mockResolvedValue(err);
    expect((await dispatch("fetch", { request: navigate("/") })).response).toBe(err);
  });

  it("serves the cached app shell when the network is unreachable", async () => {
    await install({ "/": res("<html>shell</html>") });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await dispatch("fetch", { request: navigate("/") })).response.body).toBe("<html>shell</html>");
  });
});

describe("install: precache only real same-origin answers", () => {
  it("caches the shell and assets, skips what Access redirected, and activates at once", async () => {
    await install({ "/": OPAQUE_REDIRECT, "/manifest.webmanifest": res("{}", { ct: "application/manifest+json" }) });
    const cached = caches.stores.get(currentCache())!;
    expect(cached.has(`${ORIGIN}/`)).toBe(false);
    expect(cached.has(`${ORIGIN}/manifest.webmanifest`)).toBe(true);
    expect(scope.skipWaiting).toHaveBeenCalled();
  });

  it("doesn't cache a redirected or non-HTML shell (an Access login page that answered 200)", async () => {
    await install({ "/": res("login", { redirected: true }) });
    expect(caches.stores.get(currentCache())!.has(`${ORIGIN}/`)).toBe(false);
    load();
    await install({ "/": res("{}", { ct: "application/json" }) });
    expect(caches.stores.get(currentCache())!.has(`${ORIGIN}/`)).toBe(false);
  });

  it("copies hashed assets the previous build already cached instead of downloading them again", async () => {
    load(["/assets/index-same.js", "/assets/font-same.woff2", "/assets/index-new.css"]);
    const old = await caches.open("agent-inbox-old");
    const js = res("console.log(1)", { ct: "text/javascript" });
    await old.put("/assets/index-same.js", js);
    await old.put("/assets/font-same.woff2", res("woff2", { ct: "font/woff2" }));
    await old.put("/manifest.webmanifest", res("{old}", { ct: "application/manifest+json" }));
    await old.put("/", res("<html>old</html>"));
    const fetched: string[] = [];
    fetchMock.mockImplementation(async (r: any) => (fetched.push(new URL(r.url).pathname), res("new")));
    await dispatch("install");
    // A hashed name never changes content: only the new asset and the unhashed files go to the network.
    expect(fetched).not.toContain("/assets/index-same.js");
    expect(fetched).not.toContain("/assets/font-same.woff2");
    expect(fetched).toEqual(expect.arrayContaining(["/", "/manifest.webmanifest", "/assets/index-new.css"]));
    const cached = caches.stores.get(currentCache("agent-inbox-old"))!;
    expect(cached.get(`${ORIGIN}/assets/index-same.js`)).toBe(js);
    expect(cached.get(`${ORIGIN}/assets/font-same.woff2`).body).toBe("woff2");
    expect(cached.get(`${ORIGIN}/assets/index-new.css`).body).toBe("new");
    expect(cached.get(`${ORIGIN}/`).body).toBe("new"); // the shell is never carried over
    expect(cached.get(`${ORIGIN}/manifest.webmanifest`).body).toBe("new");
  });

  it("carries over only from its own earlier caches", async () => {
    load(["/assets/index-same.js"]);
    await (await caches.open("someone-else")).put("/assets/index-same.js", res("theirs"));
    const fetched: string[] = [];
    fetchMock.mockImplementation(async (r: any) => (fetched.push(new URL(r.url).pathname), res("ours")));
    await dispatch("install");
    expect(fetched).toContain("/assets/index-same.js");
    expect(caches.stores.get(currentCache())!.get(`${ORIGIN}/assets/index-same.js`).body).toBe("ours");
  });

  it("revalidates the unhashed files with the server instead of trusting the HTTP cache", async () => {
    load(["/assets/index-new.js"]);
    const modes: Record<string, string> = {};
    fetchMock.mockImplementation(async (r: any) => ((modes[new URL(r.url).pathname] = r.cache), res("x")));
    await dispatch("install");
    for (const p of ["/", "/manifest.webmanifest", "/icons/icon-192.png"]) expect(modes[p], p).toBe("no-cache");
  });

  it("activate drops other builds' caches, keeps unrelated ones, and claims open pages", async () => {
    await caches.open("agent-inbox-old");
    await caches.open("someone-else");
    await install();
    await dispatch("activate");
    expect([...caches.stores.keys()].sort()).toEqual([currentCache(), "someone-else"].sort());
    expect(currentCache()).not.toBe("agent-inbox-old");
    expect(scope.clients.claim).toHaveBeenCalled();
  });
});

describe("built assets: cache first", () => {
  it("serves a cached asset without the network, and caches one it had to fetch", async () => {
    await install();
    const js = res("console.log(1)", { ct: "text/javascript" });
    fetchMock.mockResolvedValue(js);
    expect((await dispatch("fetch", { request: get("/assets/index-abc.js") })).response).toBe(js);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect((await dispatch("fetch", { request: get("/assets/index-abc.js") })).response.body).toBe("console.log(1)");
  });

  it("doesn't cache an asset answer that isn't a plain 200", async () => {
    await install();
    fetchMock.mockResolvedValue(OPAQUE_REDIRECT);
    await dispatch("fetch", { request: get("/assets/other.css") });
    expect(caches.stores.get(currentCache())!.has(`${ORIGIN}/assets/other.css`)).toBe(false);
  });
});

describe("push", () => {
  const data = (v: unknown) => ({ json: () => (typeof v === "string" ? JSON.parse(v) : v), text: () => String(v) });

  it("shows the item's notification, tagged by item, linking to it", async () => {
    await dispatch("push", { data: data({ title: "Do X", body: "Ship it?", url: "/#item.a1", tag: "a1" }) });
    expect(scope.registration.showNotification).toHaveBeenCalledWith("Do X", {
      body: "Ship it?",
      tag: "a1",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: "/#item.a1" },
    });
  });

  it("always shows something, even for an empty or malformed push", async () => {
    await dispatch("push", { data: null });
    await dispatch("push", { data: data("not json{") });
    const calls = scope.registration.showNotification.mock.calls;
    expect(calls.map((c: any[]) => c[0])).toEqual(["Agent Inbox", "Agent Inbox"]);
    expect(calls[1][1]).toMatchObject({ body: "not json{", data: { url: "/" } });
  });
});

describe("notificationclick", () => {
  const click = (url: unknown) => {
    const notification = { data: { url }, close: vi.fn() };
    return { notification, done: dispatch("notificationclick", { notification }) };
  };

  it("focuses an open window and tells it which item to show", async () => {
    const win = { url: `${ORIGIN}/#inbox`, focus: vi.fn(async () => win), postMessage: vi.fn() };
    windows = [{ url: "https://other.example/", focus: vi.fn(), postMessage: vi.fn() }, win];
    const { notification, done } = click("/#item.a1");
    await done;
    expect(notification.close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalledWith({ type: "open", url: `${ORIGIN}/#item.a1` });
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a window on the item when none is open", async () => {
    await click("/#item.a1").done;
    expect(scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#item.a1`);
  });

  it("only ever opens this app's own pages", async () => {
    await click("https://evil.example/phish").done;
    expect(scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});
