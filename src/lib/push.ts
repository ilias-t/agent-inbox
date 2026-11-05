// Pure helpers for Settings → Notifications (src/pwa.ts does the browser calls).

// What the page knows about this browser, gathered by src/pwa.ts.
export interface PushEnv {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean; // running as the installed home-screen app
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission: NotificationPermission | null;
}

// ok: can be turned on. install: iPhone/iPad in a Safari tab, where Web Push
// only exists once the app is added to the Home Screen (iOS 16.4+).
// unsupported: no Web Push here. blocked: the person said no; only the
// browser's or the OS's settings can undo that.
export type PushSupport = "ok" | "install" | "unsupported" | "blocked";

export function isIos(e: Pick<PushEnv, "ua" | "platform" | "maxTouchPoints">): boolean {
  // iPadOS Safari reports itself as a Mac; a Mac has no touch points.
  return /iPhone|iPad|iPod/.test(e.ua) || (e.platform === "MacIntel" && e.maxTouchPoints > 1);
}

export function pushSupport(e: PushEnv): PushSupport {
  if (isIos(e) && !e.standalone) return "install";
  if (!e.serviceWorker || !e.pushManager || !e.notification) return "unsupported";
  if (e.permission === "denied") return "blocked";
  return "ok";
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// A subscription is bound to the key it was made with; after the server's key
// changes (secrets set, or a new D1 key) it must be made again.
export function sameKey(subscribedWith: ArrayBuffer | null, serverKey: Uint8Array): boolean {
  if (!subscribedWith) return false;
  const a = new Uint8Array(subscribedWith);
  return a.length === serverKey.length && a.every((x, i) => x === serverKey[i]);
}
