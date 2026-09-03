import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** Pending invites expire after this window; accept must happen before it. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
/** Invite emails (create + resend) one team may trigger per hour. */
export const INVITE_EMAILS_PER_HOUR = 20;
/** Minimum gap between two emails for the same invitation. */
export const INVITE_RESEND_COOLDOWN_MS = 2 * 60 * 1000;
/** Emails one invitation may ever trigger; past it, revoke and re-invite. */
export const INVITE_MAX_SENDS = 5;

const HKDF_INFO = "team-invitation";

/**
 * Signing key derived from the auth secret so invite MACs never share a key
 * with anything else that secret protects (domain separation, like the
 * tracking and unsubscribe keys).
 */
function deriveInviteKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), HKDF_INFO, 32));
}

/**
 * Invitation accept links carry an HMAC-signed, opaque token derived from the
 * invite's row id — nothing secret is stored at rest, so the server can
 * reproduce the link, while forgery needs the server's auth secret.
 * Single-use and expiry are enforced by the row (acceptedAt / expiresAt), not
 * the token, which is stateless.
 */
export function signInviteToken(inviteId: string, secret: string): string {
  const mac = createHmac("sha256", deriveInviteKey(secret)).update(inviteId).digest("base64url");
  return `${Buffer.from(inviteId, "utf8").toString("base64url")}.${mac}`;
}

/** Returns the invite id when the token is intact and correctly signed, else null. */
export function verifyInviteToken(token: string, secret: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const inviteId = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  if (!inviteId) return null;
  const expected = signInviteToken(inviteId, secret);
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? inviteId : null;
}
