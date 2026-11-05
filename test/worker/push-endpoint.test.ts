// The one push endpoint rule, shared by subscribe (400 on null) and by every
// send and the daily sweep (delete on null). Route-level cases live in push.test.ts.
import { describe, expect, it } from "vitest";
import { pushEndpoint } from "../../worker/push-endpoint.ts";

describe("pushEndpoint", () => {
  it("returns a push service endpoint normalized: lower-case host, no trailing dot, no default port", () => {
    expect(pushEndpoint("https://FCM.GoogleAPIs.com.:443/fcm/send/X", undefined)?.href).toBe("https://fcm.googleapis.com/fcm/send/X");
  });

  it.each([
    ["a host that isn't a push service", "https://evil.workers.dev/x"],
    ["http", "http://fcm.googleapis.com/x"],
    ["another port", "https://fcm.googleapis.com:8443/x"],
    ["credentials", "https://u:p@fcm.googleapis.com/x"],
    ["an IP literal", "https://10.0.0.1/x"],
    ["not a URL", "not a url"],
    ["not a string", 42],
  ])("returns null for %s", (_name, raw) => {
    expect(pushEndpoint(raw, undefined)).toBeNull();
  });

  it("allows PUSH_ENDPOINT_HOSTS and their subdomains, never a private name", () => {
    const extra = " push.example.org , *.relay.example.net, corp ";
    expect(pushEndpoint("https://eu.push.example.org/a", extra)?.hostname).toBe("eu.push.example.org");
    expect(pushEndpoint("https://a.relay.example.net/a", extra)).not.toBeNull();
    expect(pushEndpoint("https://intranet.corp/a", extra)).toBeNull();
    expect(pushEndpoint("https://eu.push.example.org/a", undefined)).toBeNull();
  });
});
