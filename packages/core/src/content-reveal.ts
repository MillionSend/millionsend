/**
 * Break-glass content access: the vocabulary and the limits. Pure list, safe
 * to import from client components (no db or node imports) — the redaction
 * pass itself lives in content-reveal-render.ts, which is not.
 */

/** Why an operator may unwrap content. Security only; chosen before anything decrypts. */
export const CONTENT_REVEAL_REASONS = [
  "phishing_or_malware",
  "complaint_spike",
  "provider_report",
  "legal_request",
  "owner_support_request",
] as const;
export type ContentRevealReason = (typeof CONTENT_REVEAL_REASONS)[number];

/**
 * Reasons that read one named message, never a window: a customer asks about
 * a message, and the law names what it requires. Mirrors "a specific message"
 * in the hosted privacy policy (millionsend-lp src/app/privacy/page.tsx, §5).
 */
export const CONTENT_REVEAL_ONE_MESSAGE_REASONS: readonly ContentRevealReason[] = [
  "legal_request",
  "owner_support_request",
];

/** One message, or every flagged message of the review page's window. */
export const CONTENT_REVEAL_SCOPES = ["email", "flagged_window"] as const;
export type ContentRevealScope = (typeof CONTENT_REVEAL_SCOPES)[number];

/** A grant opens for this long and is never extended; a later look needs a new grant. */
export const CONTENT_REVEAL_WINDOW_MS = 30 * 60_000;
/** Shortest justification that says anything; enforced at the procedure and in the dialog. */
export const CONTENT_REVEAL_JUSTIFICATION_MIN = 20;
export const CONTENT_REVEAL_JUSTIFICATION_MAX = 2_000;
/** Longer bodies are cut: the operator is triaging a lure, not reading a newsletter. */
export const CONTENT_REVEAL_TEXT_MAX_CHARS = 20_000;
/** Days after which the access appears in the team's own audit and its owners are told. */
export const CONTENT_REVEAL_NOTICE_DAYS = 7;

/** What the audit rows say was read, on both sides. */
export const CONTENT_REVEAL_FIELDS = "subject, rendered text";

export function contentRevealExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CONTENT_REVEAL_WINDOW_MS);
}

/** A run of the revealed body; `redacted` runs were replaced or shortened by the server. */
export interface RevealSpan {
  text: string;
  redacted?: true;
}

export interface RevealedContent {
  spans: RevealSpan[];
  redactions: number;
}
