// JSON responses (with the security headers, shared/security-headers.ts), typed errors and body parsing shared by every route.

import { API_HEADERS } from "../shared/security-headers.ts";
import type { Doc, ReviewRun, ReviewRunRequestResponse } from "../shared/types.ts";

export const BODY_LIMIT = 256 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
}

// Thrown anywhere in a handler; the router turns it into {error, message, current?, index?}.
export class HttpError extends Error {
  // Which op of a POST /api/batch failed, when one did.
  index?: number;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    // The doc as it is now (a review run for /api/reviews/report, the routine's run request for its writes).
    readonly current?: Doc<unknown> | ReviewRun | ReviewRunRequestResponse | null,
  ) {
    super(message);
  }
}

// Tags an error with the batch op it came from (non-HTTP errors stay 500s).
export function atIndex(e: unknown, index: number): unknown {
  if (e instanceof HttpError && e.index === undefined) e.index = index;
  return e;
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const unauthorized = (message = "Authentication required") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed for this token") => new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
// 409s carry the document as it is now, so the caller can re-read without a round trip.
export const conflict = (code: string, message: string, current: Doc<unknown> | ReviewRun | ReviewRunRequestResponse | null) =>
  new HttpError(409, code, message, current);

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const body: Record<string, unknown> = { error: e.code, message: e.message };
    if (e.current !== undefined) body.current = e.current;
    if (e.index !== undefined) body.index = e.index;
    return json(body, e.status);
  }
  console.error(e);
  return json({ error: "internal", message: "Internal error" }, 500);
}

// The raw body, refusing anything over the limit whether or not Content-Length says so. Every route reads
// with BODY_LIMIT but POST /api/reviews/report, which passes its own (1 MiB).
export async function readBytes(request: Request, limit = BODY_LIMIT): Promise<ArrayBuffer> {
  const tooLarge = () => new HttpError(413, "too_large", `Body over ${limit / 1024} KiB`);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw tooLarge();
  const buf = await request.arrayBuffer();
  if (buf.byteLength > limit) throw tooLarge();
  return buf;
}

export async function readText(request: Request, limit = BODY_LIMIT): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, limit));
}

// Keys no body may use, at any depth. JSON.parse makes "__proto__" an own key, and a merge that assigns it
// (out[k] = v) swaps the target's prototype: guards then read a field through it while the stored JSON drops
// it. "constructor" and "prototype" reach the same places through other helpers.
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

class UnsafeKey extends Error {}

// A JSON object body; an empty body reads as {} so optional-body POSTs work.
export async function readJson(request: Request, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  const text = await readText(request, limit);
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text, (k, v) => {
      if (UNSAFE_KEYS.has(k)) throw new UnsafeKey(k);
      return v;
    });
  } catch (e) {
    if (e instanceof UnsafeKey) throw badRequest(`Body may not use "${e.message}" as a key`);
    throw badRequest("Body is not valid JSON");
  }
  if (!isObject(body)) throw badRequest("Body must be a JSON object");
  return body;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- Field helpers -----------------------------------------------------------

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function checkId(id: string): string {
  if (!ID_RE.test(id)) throw badRequest(`Invalid id: ${id.slice(0, 140)}`);
  return id;
}

// Loose on purpose: Access emails, and dev@localhost, which has no dot.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

// A trimmed, lowercased email (the assignee column and people keys compare
// case-sensitively), or a 400 naming `what`.
export function checkEmail(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s.length > 254 || !EMAIL_RE.test(s)) throw badRequest(`${what} must be an email`);
  return s;
}

// `if_version` from a body or query string: undefined when absent.
export function ifVersion(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isInteger(n) || (n as number) < 0) throw badRequest("if_version must be a non-negative integer");
  return n as number;
}

export function optString(body: Record<string, unknown>, key: string, max = 2000): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > max) throw badRequest(`${key} must be a string of at most ${max} chars`);
  return v;
}

export function reqString(body: Record<string, unknown>, key: string, max = 2000): string {
  const v = optString(body, key, max);
  if (!v || !v.trim()) throw badRequest(`${key} is required`);
  return v;
}

// --- Crypto ------------------------------------------------------------------

const enc = new TextEncoder();

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export async function hmacHex(secret: string, message: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, typeof message === "string" ? enc.encode(message) : message));
}

// Constant-time string compare; lengths are not secret here (fixed-size hex).
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}
