/**
 * Left-anchored status wash for banners/cards. Hue comes from the status
 * token, so the light theme's darker variants apply automatically instead of
 * baking in the dark palette's rgba values.
 */
export function statusGlow(status: "success" | "info" | "warn" | "danger", pct = 14): string {
  return `radial-gradient(130% 200% at 0% 50%, color-mix(in srgb, var(--ms-${status}) ${pct}%, transparent), transparent 58%)`;
}
