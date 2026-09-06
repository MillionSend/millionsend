import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Signed confirmation tokens for the product-updates opt-in: the link in the
 * confirmation email is the consent, so the contact exists only once it is
 * opened. Payload `source|email|issuedAt` as base64url, then an HMAC over
 * it; self-contained, so nothing is stored for an address that never
 * confirms. The signing key is HKDF-derived from the master key, like the
 * unsubscribe key, so the KEK itself never signs anything.
 */

const HKDF_INFO = "millionsend:updates:v1";

export const UPDATES_SOURCES = ["self-host", "updates"] as const;
export type UpdatesSource = (typeof UPDATES_SOURCES)[number];

export function deriveUpdatesKey(masterKey: Buffer): Buffer {
  if (masterKey.length < 16) throw new Error("master key too short to derive from");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, 32));
}

function sign(payload: string, secretKey: Buffer): string {
  return createHmac("sha256", secretKey).update(payload).digest("base64url");
}

export function makeUpdatesToken(params: {
  email: string;
  source: UpdatesSource;
  issuedAt: number;
  secretKey: Buffer;
}): string {
  const payload = Buffer.from(
    `${params.source}|${params.email}|${params.issuedAt}`,
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, params.secretKey)}`;
}

/** The signed address and source, or null for a tampered, malformed or stale token. */
export function verifyUpdatesToken(
  token: string,
  secretKey: Buffer,
  opts: { maxAgeMs: number; now?: number },
): { email: string; source: UpdatesSource } | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  // Compared in encoded space: base64url decoding ignores trailing padding
  // bits, so a byte-level comparison would accept non-canonical signatures.
  const mac = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secretKey), "utf8");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  const [source, email, issued] = Buffer.from(payload, "base64url").toString("utf8").split("|");
  if (!email || !(UPDATES_SOURCES as readonly string[]).includes(source ?? "")) return null;
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || (opts.now ?? Date.now()) - issuedAt > opts.maxAgeMs) {
    return null;
  }
  return { email, source: source as UpdatesSource };
}
