import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ApiKeyMode = "live" | "test";

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
export function generateApiKey(mode: ApiKeyMode): GeneratedApiKey {
  const secret = randomBytes(24).toString("base64url");
  const token = `ms_${mode}_${secret}`;
  return {
    token,
    tokenPrefix: `ms_${mode}_${secret.slice(0, PREFIX_SECRET_CHARS)}`,
    keyHash: hashApiKey(token),
    last4: token.slice(-4),
  };
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Lookup handle for a presented token; null when the shape is not ours. */
export function extractTokenPrefix(token: string): string | null {
  const match = /^ms_(live|test)_[A-Za-z0-9_-]{6}/.exec(token);
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
