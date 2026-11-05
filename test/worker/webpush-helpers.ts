// Test-side Web Push helpers: the receiving end of RFC 8291, written
// independently from worker/webpush.ts, and keys in WebCrypto's JWK shape.
import { expect } from "vitest";
import { b64urlDecode, b64urlEncode, ecdhPublic } from "../../worker/webpush.ts";

const enc = new TextEncoder();

// A private key from raw `d` and its uncompressed public point, as WebCrypto wants it (JWK).
export function ecJwk(pub: string, d: string): JsonWebKey {
  const p = b64urlDecode(pub);
  return { kty: "EC", crv: "P-256", x: b64urlEncode(p.slice(1, 33)), y: b64urlEncode(p.slice(33, 65)), d };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The receiving side of RFC 8291, so a round trip with a random salt and key
// proves more than the fixed vector does.
export async function decryptPayload(body: Uint8Array, uaPublic: string, uaPrivate: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const priv = await crypto.subtle.importKey("jwk", ecJwk(uaPublic, uaPrivate), { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhPublic(pub), priv, 256));
  const ikm = await hkdf(b64urlDecode(auth), ecdh, concat(enc.encode("WebPush: info\0"), b64urlDecode(uaPublic), asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter, no padding
  return new TextDecoder().decode(plain.slice(0, -1));
}

// A browser-like subscription: p256dh/auth as PushSubscription.toJSON() gives them, plus the private half.
export async function newSubscriptionKeys(): Promise<{ p256dh: string; auth: string; priv: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { p256dh: b64urlEncode(raw), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))), priv: jwk.d! };
}
