// Which URLs the Worker will POST a Web Push to. One rule, checked when a
// device subscribes (worker/routes/push.ts, 400 otherwise), again before every
// send, and by the daily cron (worker/hooks/webpush.ts): a row stored before
// the allowlist, or under a PUSH_ENDPOINT_HOSTS entry since removed, is
// deleted instead of pushed to.

// The browsers' push services, as host suffixes (the host itself or any
// subdomain). The Worker POSTs to whatever endpoint is stored, so only these
// are accepted (docs/deploy.md, "Web Push", has the sources):
//   push.apple.com             Safari (Apple: "allow access for https://*.push.apple.com")
//   push.services.mozilla.com  Firefox (updates.push.services.mozilla.com)
//   notify.windows.com         Edge on Windows (WNS, e.g. wns2-par02p.notify.windows.com)
//   googleapis.com, google.com Chrome and the other Chromium browsers (FCM): fcm.googleapis.com,
//                              and the *.google.com hosts (jmt17.google.com) current Chrome hands out
// PUSH_ENDPOINT_HOSTS adds more, comma-separated and matched the same way, for
// a browser or push service not listed here.
const PUSH_HOSTS = ["push.apple.com", "push.services.mozilla.com", "notify.windows.com", "googleapis.com", "google.com"];
// Never a push service, whatever PUSH_ENDPOINT_HOSTS says: private and special-use names.
const PRIVATE_SUFFIXES = ["localhost", "internal", "local", "lan", "home.arpa", "corp"];

const underAny = (host: string, suffixes: string[]) => suffixes.some((s) => host === s || host.endsWith("." + s));

function extraHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\*?\./, "").replace(/\.+$/, ""))
    .filter(Boolean);
}

// The URL with its host lower-cased and without a trailing dot (the parser
// already drops a default port), or null when it isn't one. Stored endpoints
// are in this form, so unsubscribing matches however the host was spelled.
export function normalizedEndpoint(v: unknown): URL | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const url = new URL(v);
    url.hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    return url;
  } catch {
    return null;
  }
}

// The endpoint, normalized, when it is an https URL without credentials on
// port 443 of a push service host (built in, or in `extra`, the
// PUSH_ENDPOINT_HOSTS value) that isn't an IP literal or a private name;
// otherwise null.
export function pushEndpoint(raw: unknown, extra: string | undefined): URL | null {
  const url = normalizedEndpoint(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname;
  // The parser turns every IPv4 spelling (hex, octal, a single number) into a dotted quad.
  const ip = host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host);
  if (ip || !host.includes(".") || underAny(host, PRIVATE_SUFFIXES)) return null;
  return underAny(host, [...PUSH_HOSTS, ...extraHosts(extra)]) ? url : null;
}
