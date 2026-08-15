import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Signed open/click tracking tokens. Engagement tracking is app-layer: WE
 * rewrite links through our redirect endpoint and inject our own pixel, so
 * these tokens are what the /t/c and /t/o route handlers verify.
 *
 * Token format mirrors the unsubscribe tokens: `base64url(payload).base64url(mac)`
 * where mac = HMAC-SHA256 over the base64url payload string. The signing key is
 * HKDF-derived from the master key so the KEK never signs directly.
 *
 * Click payload raw bytes: `emailId "\n" url`. The url is INSIDE the signed
 * payload, so a tampered destination fails verification — the redirect can only
 * ever follow a URL we signed at send time (no open redirect). emailId is a
 * UUID and never contains a newline, so splitting on the first "\n" recovers
 * both fields no matter what the url holds.
 *
 * Open payload raw bytes: `emailId` alone.
 */

const HKDF_INFO = "millionsend:tracking:v1";

export function deriveTrackingKey(masterKey: Buffer): Buffer {
  if (masterKey.length < 16) throw new Error("master key too short to derive from");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, 32));
}

function sign(payload: string, secretKey: Buffer): Buffer {
  return createHmac("sha256", secretKey).update(payload).digest();
}

function seal(raw: string, secretKey: Buffer): string {
  const payload = Buffer.from(raw, "utf8").toString("base64url");
  return `${payload}.${sign(payload, secretKey).toString("base64url")}`;
}

/**
 * Verifies the mac and returns the decoded raw payload, or null for any
 * malformed/tampered token. The mac is compared in encoded (base64url) space:
 * byte-level comparison would accept non-canonical signatures whose final
 * character carries ignored padding bits.
 */
function unseal(token: string, secretKey: Buffer): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secretKey).toString("base64url"), "utf8");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return Buffer.from(payload, "base64url").toString("utf8");
}

export function makeClickToken(params: {
  emailId: string;
  url: string;
  secretKey: Buffer;
}): string {
  return seal(`${params.emailId}\n${params.url}`, params.secretKey);
}

export function verifyClickToken(
  token: string,
  secretKey: Buffer,
): { emailId: string; url: string } | null {
  const raw = unseal(token, secretKey);
  if (raw === null) return null;
  const nl = raw.indexOf("\n");
  if (nl < 1) return null;
  return { emailId: raw.slice(0, nl), url: raw.slice(nl + 1) };
}

export function makeOpenToken(params: { emailId: string; secretKey: Buffer }): string {
  return seal(params.emailId, params.secretKey);
}

export function verifyOpenToken(token: string, secretKey: Buffer): { emailId: string } | null {
  const raw = unseal(token, secretKey);
  if (raw === null || raw.length === 0) return null;
  return { emailId: raw };
}
