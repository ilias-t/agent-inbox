// Thin JSON client for the agent-inbox API.

export class ApiError extends Error {
  constructor(status, body) {
    const code = body && typeof body === "object" ? body.error : undefined;
    const message = body && typeof body === "object" ? body.message : undefined;
    super(`${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

// The request never reached a response (DNS, refused, reset, timeout).
export class NetworkError extends Error {}

export function isRetryable(err) {
  return err instanceof NetworkError || (err instanceof ApiError && (err.status >= 500 || err.status === 429));
}

function buildUrl(base, path, query) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== false) url.searchParams.set(k, String(v));
  }
  return url;
}

// The opt-in lease check (docs/api.md "Lease-checked writes"): a write that
// names the caller's session lands only while that session holds the lease.
export const LEASE_SESSION_HEADER = "x-lease-session";

// api(method, path, {query, body, timeoutMs}) → parsed JSON. Throws ApiError
// for non-2xx responses and NetworkError when no response arrived. With
// `session`, every write carries it as X-Lease-Session (reads never do).
export function createClient({ url, token, session, fetch: fetchImpl = globalThis.fetch }) {
  return async function api(method, path, { query, body, timeoutMs = 30_000 } = {}) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (session && method !== "GET" && method !== "HEAD") headers[LEASE_SESSION_HEADER] = session;
    if (body !== undefined) headers["content-type"] = "application/json";
    const target = buildUrl(url, path, query);
    let res;
    try {
      res = await fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (err) {
      const cause = err?.cause;
      const why =
        err?.name === "TimeoutError"
          ? `timed out after ${timeoutMs / 1000}s`
          : cause?.code || cause?.errors?.[0]?.code || cause?.message || err?.message;
      throw new NetworkError(`${method} ${target.origin}${target.pathname}: ${why}`);
    }
    if (res.status >= 300 && res.status < 400) {
      // Access answers unauthenticated requests with a redirect to its login page.
      const to = res.headers.get("location") ?? "?";
      throw new ApiError(res.status, {
        error: "redirect",
        message: `redirected to ${to}; is the Cloudflare Access bypass for /agent and /hooks in place?`,
      });
    }
    const text = await res.text().catch(() => "");
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "bad_response", message: `expected JSON, got: ${text.slice(0, 200)}` };
        throw new ApiError(res.status, parsed);
      }
    }
    if (!res.ok) throw new ApiError(res.status, parsed);
    return parsed;
  };
}
