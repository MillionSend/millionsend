/** Hex SHA-256 of the normalized (trimmed, lowercased) address — Gravatar's id. */
export async function emailSha256(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `d=404` so a missing Gravatar errors the <img> instead of serving a default. */
export function gravatarUrl(hash: string, size: number): string {
  return `https://gravatar.com/avatar/${hash}?d=404&s=${size}`;
}

/** Up to two initial letters: "Ada Lovelace" → "AL", "ada@example.com" → "A". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase();
}
