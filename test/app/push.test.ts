// Settings → Notifications: whether this device can turn on Web Push, and
// whether its subscription still matches the server's key.
import { describe, expect, it } from "vitest";
import { b64urlToBytes, pushSupport, sameKey, type PushEnv } from "../../src/lib/push.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  ua: CHROME,
  platform: "Linux armv8l",
  maxTouchPoints: 5,
  standalone: false,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: "default",
  ...over,
});

describe("pushSupport", () => {
  it("is ready in a browser with service workers, PushManager and Notification", () => {
    expect(pushSupport(env())).toBe("ok");
  });

  it("asks iPhone and iPad users to add the app to the Home Screen first when it runs in a Safari tab", () => {
    const tab = { pushManager: false, notification: false };
    expect(pushSupport(env({ ua: IPHONE, platform: "iPhone", ...tab }))).toBe("install");
    // iPadOS Safari presents as a Mac; touch points give it away.
    expect(pushSupport(env({ ua: IPAD_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 5, ...tab }))).toBe("install");
  });

  it("is ready in the installed iOS app", () => {
    expect(pushSupport(env({ ua: IPHONE, platform: "iPhone", standalone: true }))).toBe("ok");
  });

  it("is unsupported when the installed iOS app predates Web Push (no PushManager), and on a Mac without it", () => {
    expect(pushSupport(env({ ua: IPHONE, platform: "iPhone", standalone: true, pushManager: false }))).toBe("unsupported");
    expect(pushSupport(env({ ua: IPAD_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 0, serviceWorker: false }))).toBe("unsupported");
  });

  it("is blocked once the person denied notifications", () => {
    expect(pushSupport(env({ permission: "denied" }))).toBe("blocked");
  });
});

describe("keys", () => {
  it("decodes the server's base64url key", () => {
    expect([...b64urlToBytes("BP8")]).toEqual([4, 255]);
  });

  it("matches a subscription made with the same key, not one made with an older key", () => {
    const key = new Uint8Array([4, 1, 2, 3]);
    expect(sameKey(new Uint8Array([4, 1, 2, 3]).buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array([4, 1, 2, 9]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });
});
