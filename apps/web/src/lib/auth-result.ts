import type { BadgeTone } from "@/components/status-badge";

/** The checks the MX runs on every received message, in display order. */
export const AUTH_CHECKS = ["spf", "dkim", "dmarc", "arc"] as const;
export type AuthCheck = (typeof AUTH_CHECKS)[number];

// Only a pass is good news; a softfail or a lookup error is doubt, not proof.
const TONE: Record<string, BadgeTone> = {
  pass: "success",
  fail: "danger",
  softfail: "warn",
  temperror: "warn",
  permerror: "warn",
};

/** Badge tone for a mailauth verdict (RFC 8601 result words); anything else is neutral. */
export function authResultTone(result: string): BadgeTone {
  return TONE[result] ?? "neutral";
}
