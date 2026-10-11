import { createHash } from "node:crypto";

/** Strings hash as UTF-8. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
