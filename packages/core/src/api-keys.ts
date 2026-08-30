import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./hash.js";

export interface GeneratedApiKey {
  /** The full secret — shown once, never stored. */
  token: string;
  /** Indexed lookup handle: scheme prefix + first 6 secret chars. */
  tokenPrefix: string;
  /** SHA-256 hex of the full token — the only stored credential. */
  keyHash: string;
  last4: string;
}

const PREFIX_SECRET_CHARS = 6;

/** 24 random bytes → 32 base64url chars → 192 bits of entropy. */
export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(24).toString("base64url");
  const token = `ms_${secret}`;
  return {
    token,
    tokenPrefix: `ms_${secret.slice(0, PREFIX_SECRET_CHARS)}`,
    keyHash: hashApiKey(token),
    last4: token.slice(-4),
  };
}

export function hashApiKey(token: string): string {
  return sha256Hex(token);
}

/** Lookup handle for a presented token; null when the shape is not ours. */
export function extractTokenPrefix(token: string): string | null {
  const match = /^ms_[A-Za-z0-9_-]{6}/.exec(token);
  return match ? match[0] : null;
}

/**
 * Constant-time comparison of hash digests. High-entropy machine secrets use
 * a fast hash by design — bcrypt/argon2 exist for low-entropy passwords.
 */
export function verifyApiKey(presentedToken: string, storedKeyHashHex: string): boolean {
  const presented = createHash("sha256").update(presentedToken, "utf8").digest();
  const stored = Buffer.from(storedKeyHashHex, "hex");
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(presented, stored);
}

/**
 * Active keys per team, enforced on every minting surface. A full_access key
 * can mint more keys, so without a cap a leaked key could fan out into an
 * unbounded set of credentials (each with its own rate-limit bucket).
 */
export const MAX_ACTIVE_API_KEYS = 25;
