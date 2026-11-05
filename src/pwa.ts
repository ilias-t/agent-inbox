/// <reference types="vite/client" />
// The home-screen app's service worker (public/sw.js) and this device's Web
// Push subscription. The decisions are in lib/push.ts; this is the browser glue.

import { b64urlToBytes, pushSupport, sameKey, type PushEnv, type PushSupport } from "./lib/push.ts";
import { navigate } from "./lib/backnav.ts";

// Production builds only: `npm run dev` serves public/sw.js unstamped (no build hash).
// A notification tap on an open window arrives as {type: "open", url}: show that item.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { type?: string; url?: string } | null;
    if (!d || d.type !== "open" || typeof d.url !== "string") return;
    const u = new URL(d.url, location.href);
    if (u.origin === location.origin && u.hash && u.hash !== location.hash) navigate(u.hash);
  });
  // A new build's worker takes over at once (skipWaiting) but this page keeps
  // running the code it loaded; the next launch or reload gets the new build.
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((e) => console.warn("service worker", e));
}

function pushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: nav.standalone === true || matchMedia("(display-mode: standalone)").matches,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : null,
  };
}

export function devicePushSupport(): PushSupport {
  return pushSupport(pushEnv());
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

// on: subscribed with the server's current key. stale: subscribed with an
// older key (re-enable to fix). off: not subscribed. `sub` is the subscription as the server stores it.
export async function devicePushState(serverKey: string): Promise<{ state: "on" | "off" | "stale"; sub: PushSubscriptionJSON | null }> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return { state: "off", sub: null };
  return { state: sameKey(sub.options.applicationServerKey, b64urlToBytes(serverKey)) ? "on" : "stale", sub: sub.toJSON() };
}

// Call straight from a click: iOS only shows the permission prompt for a user
// gesture, so nothing is awaited before it. Returns the subscription to store
// on the server, or null when permission wasn't granted. `fresh` drops an
// existing subscription first, for a new endpoint: the server keeps an endpoint
// with the account that stored it (409 for anyone else).
export async function enableDevicePush(serverKey: string, fresh = false): Promise<PushSubscriptionJSON | null> {
  if ((await Notification.requestPermission()) !== "granted") return null;
  if (!(await registration())) throw new Error("The service worker isn't running; reload and try again.");
  const reg = await navigator.serviceWorker.ready; // subscribing needs it active, not just installing
  const key = b64urlToBytes(serverKey);
  const old = await reg.pushManager.getSubscription();
  if (old && (fresh || !sameKey(old.options.applicationServerKey, key))) await old.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  return sub.toJSON();
}

// Unsubscribes this device; returns the endpoint to forget on the server.
export async function disableDevicePush(): Promise<string | null> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return null;
  await sub.unsubscribe();
  return sub.endpoint;
}
