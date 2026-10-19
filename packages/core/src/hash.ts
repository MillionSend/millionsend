import { createHash, timingSafeEqual } from "node:crypto";

/** Strings hash as UTF-8. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time string equality for shared secrets. Both sides are hashed
 * first, so neither the comparison's duration nor a length mismatch says
 * anything about the expected value.
 */
export function secretsEqual(given: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(given, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}
