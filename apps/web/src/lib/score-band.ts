import type { EmailCheckResult, ScoreBand } from "@millionsend/core";

/** Band → status-badge tone. Bands are semantic (score health), never decorative. */
export const BAND_TONE: Record<ScoreBand, string> = {
  excellent: "success",
  good: "info",
  needs_attention: "warn",
  at_risk: "danger",
};

/** A score's colour in a list or tile: danger under 5, warn under 7, the text's own above. */
export function scoreColor(tenths: number): string | undefined {
  return tenths < 50 ? "var(--ms-danger)" : tenths < 70 ? "var(--ms-warn)" : undefined;
}

/** scoreTenths (0–100) → localized one-decimal 0–10 string ("8.5"). */
export function formatScoreTenths(scoreTenths: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(scoreTenths / 10);
}

/** Text-icon glyph + status color per check row (DESIGN.md icon system). */
export function checkGlyph(check: EmailCheckResult): { glyph: string; color: string } {
  switch (check.status) {
    case "fail":
      return {
        glyph: "✕",
        color:
          check.severity === "critical" || check.severity === "major"
            ? "var(--ms-danger)"
            : "var(--ms-warn)",
      };
    case "unknown":
      return { glyph: "?", color: "var(--ms-muted)" };
    case "not_applicable":
      return { glyph: "—", color: "var(--ms-faint)" };
    default:
      return { glyph: "✓", color: "var(--ms-success)" };
  }
}
