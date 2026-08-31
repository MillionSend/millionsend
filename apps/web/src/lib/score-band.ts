import type { ScoreBand } from "@millionsend/core";

/** Band → status-badge tone. Bands are semantic (score health), never decorative. */
export const BAND_TONE: Record<ScoreBand, string> = {
  excellent: "success",
  good: "info",
  needs_attention: "warn",
  at_risk: "danger",
};
