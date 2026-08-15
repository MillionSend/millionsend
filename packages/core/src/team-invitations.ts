import { createHmac, timingSafeEqual } from "node:crypto";

/** Pending invites expire after this window; accept must happen before it. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Invitation accept links carry an HMAC-signed, opaque token derived from the
 * invite's row id — nothing secret is stored at rest, so a pending-invites
 * list can reproduce the link, while forgery needs the server's auth secret.
 * Single-use and expiry are enforced by the row (acceptedAt / expiresAt), not
 * the token, which is stateless.
 */
export function signInviteToken(inviteId: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(inviteId).digest("base64url");
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
