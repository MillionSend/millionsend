/** What the All received list knows about a message's verdicts. */
export interface ReceivedVerdicts {
  spamVerdict: "pass" | "gray" | "fail" | null;
  virusVerdict: "pass" | "fail" | "processing_failed" | null;
  /** Some inbox it reached is still screening it. */
  pending: boolean;
  /** Some inbox holds it in quarantine. */
  quarantined: boolean;
  /** Some inbox let it in as suspicious. */
  suspicious: boolean;
}

export type ReceivedState =
  | "virus"
  | "quarantined"
  | "screening"
  | "spam"
  | "suspicious"
  | "unscanned"
  | "clean";

/**
 * The one state a received email's row leads with, the most urgent first.
 * No virus verdict means no scanner is configured, which reads as clean;
 * unscanned is a configured scanner that failed on this message.
 */
export function receivedState(row: ReceivedVerdicts): ReceivedState {
  if (row.virusVerdict === "fail") return "virus";
  if (row.quarantined) return "quarantined";
  if (row.pending) return "screening";
  if (row.spamVerdict === "fail") return "spam";
  if (row.suspicious) return "suspicious";
  if (row.virusVerdict === "processing_failed") return "unscanned";
  return "clean";
}

/** Tile and badge tone per state: danger for what is held or harmful, warn for what to doubt. */
export const RECEIVED_STATE_TONE: Record<ReceivedState, "danger" | "warn" | "neutral"> = {
  virus: "danger",
  quarantined: "danger",
  screening: "neutral",
  spam: "warn",
  suspicious: "warn",
  unscanned: "neutral",
  clean: "neutral",
};
