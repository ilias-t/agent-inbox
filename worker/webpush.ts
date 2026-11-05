// Web Push wire format with WebCrypto only: RFC 8291 message encryption
// (aes128gcm, RFC 8188 with one record) and RFC 8292 VAPID (an ES256 JWT that
// tells the push service which application server is sending). No state and
// no network here; worker/hooks/webpush.ts stores subscriptions and sends.

export interface SubscriptionKeys {
  p256dh: string; // base64url uncompressed P-256 point (65 bytes), from PushSubscription.toJSON()
  auth: string; // base64url 16-byte auth secret
}

// base64url: the raw uncompressed public point (65 bytes) and the private scalar d (32 bytes),
// the format `web-push generate-vapid-keys` prints and browsers take as applicationServerKey.
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const enc = new TextEncoder();
const RECORD_SIZE = 4096;
// A VAPID token's lifetime. RFC 8292 caps it at 24 hours; Apple rejects longer ones.
const VAPID_TTL_S = 12 * 3600;

// --- base64url ----------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Padding optional (browsers omit it); throws on anything that isn't base64url.
export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
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

function decodeKey(s: string, len: number, what: string): Uint8Array {
  let b: Uint8Array;
  try {
    b = b64urlDecode(s);
  } catch {
    throw new Error(`${what} is not base64url`);
  }
  if (b.length !== len || (len === 65 && b[0] !== 4)) throw new Error(`${what} must be ${len} bytes`);
  return b;
}

// The JWK WebCrypto needs for a P-256 private key, from the raw public point and d.
function privateJwk(publicKey: string, privateKey: string): JsonWebKey {
  const p = decodeKey(publicKey, 65, "public key");
  decodeKey(privateKey, 32, "private key");
  return { kty: "EC", crv: "P-256", x: b64urlEncode(p.slice(1, 33)), y: b64urlEncode(p.slice(33)), d: privateKey, ext: true };
}

// The raw uncompressed point of a P-256 JWK.
function rawPublic(jwk: JsonWebKey): Uint8Array {
  return concat(new Uint8Array([4]), b64urlDecode(jwk.x ?? ""), b64urlDecode(jwk.y ?? ""));
}

// Validates a VAPID key pair's shape (not that the halves match); throws with what's wrong.
export function checkVapidKeys(keys: VapidKeys): void {
  privateJwk(keys.publicKey, keys.privateKey);
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { publicKey: b64urlEncode(rawPublic(jwk)), privateKey: jwk.d ?? "" };
}

// --- RFC 8291 -------------------------------------------------------------------

// ECDH params naming the peer's public key. The runtime reads `public`;
// @cloudflare/workers-types spells the field `$public` (a reserved word in its
// generator), so the object is cast rather than typed.
export function ecdhPublic(key: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: key } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// The aes128gcm body for one subscription: header (salt, record size, the
// sender's ephemeral public key) then the single encrypted record. `opts`
// pins the salt and ephemeral key, for the RFC's test vector only.
export async function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  opts: { salt?: Uint8Array; serverKey?: JsonWebKey } = {},
): Promise<Uint8Array> {
  const uaPublic = decodeKey(keys.p256dh, 65, "p256dh");
  const authSecret = decodeKey(keys.auth, 16, "auth");
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ecdh = { name: "ECDH", namedCurve: "P-256" };

  let asPrivate: CryptoKey, asPublic: Uint8Array;
  if (opts.serverKey) {
    asPrivate = await crypto.subtle.importKey("jwk", opts.serverKey, ecdh, false, ["deriveBits"]);
    asPublic = rawPublic(opts.serverKey);
  } else {
    const kp = (await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdhPublic(uaKey), asPrivate, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 ua_public as_public), then CEK and nonce from it.
  const ikm = await hkdf(authSecret, secret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // One record: the plaintext, then the 0x02 last-record delimiter, no padding.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error("payload too large for one record");
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))),
  );

  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

// --- RFC 8292 -------------------------------------------------------------------

// `Authorization: vapid t=<JWT>, k=<public key>` for a request to `endpoint`.
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowS = Date.now() / 1000): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowS) + VAPID_TTL_S, sub: subject };
  const unsigned = `${header}.${b64urlEncode(enc.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk(keys.publicKey, keys.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto's ECDSA signature is already r || s, the JWS ES256 form.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}
