/**
 * Masks shared by every path that shows or ships text which may quote a
 * person or a credential. Pure, with no node imports, so browser code can use
 * them too.
 */

/** What a masked run is replaced with. The original never leaves the server. */
export const MASK = "••••••";

/**
 * This platform's own API key: base64url, so neither a hex nor a base64 shape
 * catches it, and it is the credential most likely to be quoted back. Shared
 * and global: use it with replace or matchAll only, since test and exec leave
 * lastIndex behind for the next caller.
 */
export const API_KEY_PATTERN = /\bms_[A-Za-z0-9_-]{20,}/g;

/**
 * The local part of an address: RFC 5322 atext and dots, Unicode letters and
 * marks for internationalised ones. "/" is left out: legal, never seen in a
 * real address, and it is what glues a link's path to an @ (youtube.com/@x).
 * A run starts only where its alphabet does, so a long run with no @ is
 * scanned once rather than from each of its characters.
 */
const EMAIL_LOCAL_PART =
  /(?<![\p{L}\p{M}\p{N}.!#$%&'*+=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+=?^_`{|}~-]+@(?=[\p{L}\p{N}])/gu;

/** `someone@example.com` → `••••••@example.com`: the domain is the signal, the local part names a person. */
export function maskEmailLocalParts(text: string, mask = MASK): string {
  return text.replace(EMAIL_LOCAL_PART, `${mask}@`);
}
