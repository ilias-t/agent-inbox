// Web Push wire format in the Workers runtime: RFC 8291 (aes128gcm message
// encryption) against the RFC's own example, and RFC 8292 (VAPID) tokens.
import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, encryptPayload, vapidAuthorization } from "../../worker/webpush.ts";
import { decryptPayload, ecJwk } from "./webpush-helpers.ts";

const enc = new TextEncoder();

// RFC 8291 Section 5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("base64url", () => {
  it("decodes without padding and with the url-safe alphabet", () => {
    expect([...b64urlDecode("_-8")]).toEqual([0xff, 0xef]);
    expect(b64urlEncode(new Uint8Array([0xff, 0xef]))).toBe("_-8");
  });
});

describe("RFC 8291 aes128gcm encryption", () => {
  it("reproduces the RFC's example message byte for byte", async () => {
    const body = await encryptPayload(
      enc.encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: b64urlDecode(RFC.salt), serverKey: ecJwk(RFC.asPublic, RFC.asPrivate) },
    );
    expect(body.length).toBe(86 + 41 + 1 + 16);
    expect(b64urlEncode(body.slice(0, 86))).toBe(RFC.header);
    expect(b64urlEncode(body.slice(86))).toBe(RFC.ciphertext);
    expect(b64urlEncode(body)).toBe(RFC.body);
  });

  it("with a random salt and server key, the receiver decrypts it", async () => {
    const body = await encryptPayload(enc.encode('{"title":"hi"}'), { p256dh: RFC.uaPublic, auth: RFC.auth });
    expect(b64urlEncode(body.slice(0, 16))).not.toBe(RFC.salt);
    expect(await decryptPayload(body, RFC.uaPublic, RFC.uaPrivate, RFC.auth)).toBe('{"title":"hi"}');
  });

  it("refuses a malformed subscription key", async () => {
    await expect(encryptPayload(enc.encode("x"), { p256dh: "AAAA", auth: RFC.auth })).rejects.toThrow(/p256dh/);
    await expect(encryptPayload(enc.encode("x"), { p256dh: RFC.uaPublic, auth: "AAAA" })).rejects.toThrow(/auth/);
  });
});

describe("RFC 8292 VAPID", () => {
  it("signs an ES256 JWT for the push service's origin that verifies with the public key", async () => {
    const now = 1_760_000_000;
    const keys = { publicKey: RFC.asPublic, privateKey: RFC.asPrivate };
    const header = await vapidAuthorization("https://web.push.apple.com/QGuQ-abc?x=1", keys, "mailto:ops@example.com", now);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [jwt, k] = [m![1], m![2]];
    expect(k).toBe(RFC.asPublic);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p)))).toEqual({
      aud: "https://web.push.apple.com",
      exp: now + 12 * 3600,
      sub: "mailto:ops@example.com",
    });
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(s), enc.encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });
});
