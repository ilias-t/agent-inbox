// agent-inbox service worker: an offline app shell and Web Push notifications.
//
// It never touches /api, /agent, /hooks or /cdn-cgi (Cloudflare Access), or
// any other origin: those requests go to the network exactly as without it.
// Navigations are network first and pass through whatever comes back, Access
// sign-in redirects included; the cached shell is used only when the network
// can't be reached at all. Only this build's same-origin files are cached.
//
// The build (vite.config.ts, serviceWorker plugin) replaces the two markers
// below with a hash of dist/ and the list of hashed assets, so every deploy
// gets a new cache and the old one is dropped on activate; install copies the
// unchanged hashed assets across from it rather than downloading them again.
// Tested in test/app/sw.test.ts.

const BUILD = "__SW_BUILD__";
const ASSETS = /*__SW_ASSETS__*/ [];

const CACHE = "agent-inbox-" + BUILD;
const SHELL = "/";
const PRECACHE = [SHELL, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/badge-96.png", "/icons/apple-touch-icon.png"].concat(ASSETS);
const CACHED_PATHS = new Set(PRECACHE.filter((p) => p !== SHELL));
const BYPASS = /^\/(api|agent|hooks|cdn-cgi)(\/|$)/;

// A response worth keeping: a plain 200 from this origin, not something Access
// redirected (an opaque redirect, or a login page reached through one).
function cacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type === "basic" && !res.redirected;
}

// A content-hashed build file (Vite's /assets/): the same name always has the same bytes.
const hashed = (path) => path.startsWith("/assets/");

// What an earlier build's cache already holds for path, if anything. Only this app's caches; the
// previous build's is still there during install (activate drops it).
async function carriedOver(path, previous) {
  for (const name of previous) {
    const hit = await (await caches.open(name)).match(path);
    if (hit) return hit;
  }
  return undefined;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const previous = (await caches.keys()).filter((name) => name.startsWith("agent-inbox-") && name !== CACHE);
      // Best effort, one by one: a signed-out install still installs, just without what Access redirected.
      // A deploy downloads only what changed: hashed assets an earlier build cached are copied over, and
      // the unhashed files (the shell, manifest, icons) are revalidated, so an unchanged one costs a 304.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            const kept = hashed(path) ? await carriedOver(path, previous) : undefined;
            if (kept) return await cache.put(path, kept);
            const url = new URL(path, self.location.origin).href;
            const mode = hashed(path) ? "default" : "no-cache";
            const res = await fetch(new Request(url, { cache: mode, redirect: "manual", credentials: "same-origin" }));
            if (!cacheable(res)) return;
            if (path === SHELL && !(res.headers.get("content-type") || "").includes("text/html")) return;
            await cache.put(path, res);
          } catch {
            /* offline or refused: left to the network later */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("agent-inbox-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || BYPASS.test(url.pathname)) return;
  if (req.mode === "navigate") event.respondWith(navigation(req));
  else if (url.pathname.startsWith("/assets/") || CACHED_PATHS.has(url.pathname)) event.respondWith(cacheFirst(req, url.pathname));
});

// The network's answer whatever it is (a 302 to Access, a 5xx); the shell only on a network error.
async function navigation(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const shell = await (await caches.open(CACHE)).match(SHELL);
    if (shell) return shell;
    throw e;
  }
}

async function cacheFirst(req, path) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(path);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) await cache.put(path, res.clone());
  return res;
}

// --- Push ------------------------------------------------------------------------
// Payload (worker/hooks/webpush.ts): {title, body, url, tag}. Every push shows
// a notification; browsers penalize (and iOS revokes) pushes that don't.

self.addEventListener("push", (event) => {
  let msg = {};
  if (event.data) {
    try {
      msg = event.data.json() || {};
    } catch {
      msg = { body: event.data.text() };
    }
  }
  const title = typeof msg.title === "string" && msg.title ? msg.title : "Agent Inbox";
  const options = { body: typeof msg.body === "string" ? msg.body : "" };
  // A newer push about the same item replaces the older notification.
  if (typeof msg.tag === "string" && msg.tag) options.tag = msg.tag;
  options.icon = "/icons/icon-192.png";
  options.badge = "/icons/badge-96.png"; // monochrome: Android draws it in the status bar
  options.data = { url: typeof msg.url === "string" ? msg.url : "/" };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an open window and have it show the item (src/main.ts listens for
// {type: "open"}), else open one. Only this origin's pages, whatever the payload says.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const origin = self.location.origin;
  let url = origin + "/";
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || "/", origin);
    if (u.origin === origin) url = u.href;
  } catch {
    /* keep the app's root */
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => {
        try {
          return new URL(w.url).origin === origin;
        } catch {
          return false;
        }
      });
      if (win) {
        try {
          await win.focus();
        } catch {
          /* focus isn't always allowed; still navigate it */
        }
        win.postMessage({ type: "open", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
