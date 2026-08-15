import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Signed one-click unsubscribe tokens (RFC 8058). Token format:
 * `base64url(contactId).base64url(HMAC-SHA256(base64url(contactId)))` —
 * self-contained, no DB lookup needed to authenticate the link.
 */

// Domain-separation label: the signing key is HKDF-derived from the master
// encryption key so the KEK itself never signs anything.
const HKDF_INFO = "millionsend:unsubscribe:v1";

export function deriveUnsubscribeKey(masterKey: Buffer): Buffer {
  if (masterKey.length < 16) throw new Error("master key too short to derive from");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, 32));
}

function sign(payload: string, secretKey: Buffer): Buffer {
  return createHmac("sha256", secretKey).update(payload).digest();
}

export function makeUnsubscribeToken(params: { contactId: string; secretKey: Buffer }): string {
  const payload = Buffer.from(params.contactId, "utf8").toString("base64url");
  return `${payload}.${sign(payload, params.secretKey).toString("base64url")}`;
}

/** @returns the contactId, or null for any malformed/tampered token. */
export function verifyUnsubscribeToken(token: string, secretKey: Buffer): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  // Compare in encoded space: base64url decoding ignores the final padding
  // bits, so byte-level comparison would accept non-canonical signatures
  // (e.g. a trailing "A" tampered to "B" decodes identically).
  const mac = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secretKey).toString("base64url"), "utf8");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  const contactId = Buffer.from(payload, "base64url").toString("utf8");
  return contactId.length > 0 ? contactId : null;
}

/** RFC 8058 one-click unsubscribe headers for outgoing mail. */
export function buildUnsubscribeHeaders(
  baseUrl: string,
  token: string,
): { "List-Unsubscribe": string; "List-Unsubscribe-Post": string } {
  const url = new URL(`unsubscribe/${token}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return {
    "List-Unsubscribe": `<${url.toString()}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
