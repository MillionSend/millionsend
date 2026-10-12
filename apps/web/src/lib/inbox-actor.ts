/** An inbox_activity actor as core encodeInboxActor wrote it, read back. */
export type ParsedInboxActor =
  | { kind: "user"; userId: string }
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "oauth"; clientId: string; userId: string }
  | { kind: "system" };

/** Inverse of encodeInboxActor; anything else reads as system. */
export function parseInboxActor(encoded: string): ParsedInboxActor {
  if (encoded.startsWith("user:")) return { kind: "user", userId: encoded.slice(5) };
  if (encoded.startsWith("api_key:")) return { kind: "api_key", apiKeyId: encoded.slice(8) };
  if (encoded.startsWith("oauth:")) {
    // The user id is last: a client id may itself carry colons.
    const rest = encoded.slice(6);
    const cut = rest.lastIndexOf(":");
    if (cut > 0)
      return { kind: "oauth", clientId: rest.slice(0, cut), userId: rest.slice(cut + 1) };
  }
  return { kind: "system" };
}
