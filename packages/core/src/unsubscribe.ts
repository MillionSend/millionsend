import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Signed one-click unsubscribe tokens (RFC 8058). Token format:
 * `base64url(payload).base64url(HMAC-SHA256(base64url(payload)))` where the raw
 * payload is `contactId` (global unsubscribe) or `contactId.topicId`
 * (topic-scoped). Both are UUIDs, so a single "." separates them unambiguously.
 * Self-contained: no DB lookup needed to authenticate the link.
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

export function makeUnsubscribeToken(params: {
  contactId: string;
  topicId?: string | null;
  secretKey: Buffer;
}): string {
  const raw = params.topicId ? `${params.contactId}.${params.topicId}` : params.contactId;
  const payload = Buffer.from(raw, "utf8").toString("base64url");
  return `${payload}.${sign(payload, params.secretKey).toString("base64url")}`;
}

/**
 * @returns the signed contactId and optional topicId, or null for any
 * malformed/tampered token.
 */
export function verifyUnsubscribeToken(
  token: string,
  secretKey: Buffer,
): { contactId: string; topicId: string | null } | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  // Compare in encoded space: base64url decoding ignores the final padding
  // bits, so byte-level comparison would accept non-canonical signatures
  // (e.g. a trailing "A" tampered to "B" decodes identically).
  const mac = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secretKey).toString("base64url"), "utf8");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  const parts = Buffer.from(payload, "base64url").toString("utf8").split(".");
  const contactId = parts[0] ?? "";
  if (contactId.length === 0 || parts.length > 2) return null;
  return { contactId, topicId: parts[1] || null };
}

/**
 * The `/unsubscribe/<token>` link. An empty token yields the bare
 * `/unsubscribe/` prefix, used to exclude the in-body link from click tracking.
 */
export function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  return new URL(
    `unsubscribe/${token}`,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

/**
 * Literal body tokens replaced per recipient with their hosted unsubscribe
 * URL. {{{RESEND_UNSUBSCRIBE_URL}}} is the Resend-compatible alias.
 */
export const UNSUBSCRIBE_URL_TOKENS = [
  "{{{UNSUBSCRIBE_URL}}}",
  "{{{RESEND_UNSUBSCRIBE_URL}}}",
] as const;

/**
 * Replaces every unsubscribe token with `url`. Pass "" when no URL can be
 * built — a literal placeholder token must never reach an inbox.
 */
export function substituteUnsubscribeUrl(content: string, url: string): string {
  let out = content;
  for (const token of UNSUBSCRIBE_URL_TOKENS) out = out.replaceAll(token, url);
  return out;
}

/** RFC 8058 one-click unsubscribe headers for outgoing mail. */
export function buildUnsubscribeHeaders(
  baseUrl: string,
  token: string,
): { "List-Unsubscribe": string; "List-Unsubscribe-Post": string } {
  return {
    "List-Unsubscribe": `<${buildUnsubscribeUrl(baseUrl, token)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
