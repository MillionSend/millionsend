/**
 * Remembers the audience a team last viewed so /audience (no id in the URL)
 * resolves to where the user left off instead of always the default one.
 * Keyed by team: switching teams must not carry the selection across.
 */
const KEY_PREFIX = "ms-audience:";

export function readLastAudience(teamId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + teamId);
  } catch {
    return null;
  }
}

export function writeLastAudience(teamId: string, audienceId: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + teamId, audienceId);
  } catch {
    /* storage may be unavailable (private mode) — selection just won't persist */
  }
}
