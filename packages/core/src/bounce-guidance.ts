/**
 * Maps SES bounce/complaint detail to a stable i18n key + category. The prose
 * lives in the messages/{locale}/bounce-guidance.json catalog; this resolver
 * only decides WHICH entry applies. Every key it can return must exist in both
 * locale catalogs (guarded by bounce-guidance.test.ts).
 *
 * Precedence for bounces: provider+domain match > enhanced-code match >
 * SES subtype match > bounceType generic > unknown fallback.
 */

export type BounceCategory =
  | "recipient"
  | "content"
  | "reputation"
  | "policy"
  | "provider"
  | "transient"
  | "unknown";

export interface BounceGuidance {
  /** i18n key prefix; the catalog entry has `.title`, `.body`, `.action`. */
  key: string;
  /** Display SMTP code like "550 5.1.1", or null when the diagnostic has none. */
  smtpCode: string | null;
  category: BounceCategory;
}

export interface ResolveBounceInput {
  bounceType?: string | null | undefined;
  bounceSubType?: string | null | undefined;
  diagnosticCode?: string | null | undefined;
  recipientDomain?: string | null | undefined;
}

/**
 * Parses an SMTP diagnostic into its display form ("550 5.1.1") and the RFC
 * 3463 enhanced status ("5.1.1"). Shared so pages stop re-implementing the
 * extraction regex.
 */
export function parseSmtpDiagnostic(diagnostic: string | null | undefined): {
  display: string | null;
  enhanced: string | null;
} {
  if (!diagnostic) return { display: null, enhanced: null };
  const match = /(\d{3})[ -]+(\d+\.\d+\.\d+)/.exec(diagnostic);
  if (!match) return { display: null, enhanced: null };
  return { display: `${match[1]} ${match[2]}`, enhanced: match[2] as string };
}

const CATEGORY_OF: Record<string, BounceCategory> = {
  "provider.apple": "provider",
  "provider.googleBulk": "provider",
  "provider.microsoftBlock": "provider",
  "code.noMailbox": "recipient",
  "code.badDomain": "recipient",
  "code.mailboxDisabled": "recipient",
  "code.mailboxFull": "transient",
  "code.messageTooLarge": "content",
  "code.dnsRouting": "recipient",
  "code.policyBlock": "policy",
  "code.authFailure": "policy",
  "code.greylisted": "transient",
  "subtype.permanentGeneral": "recipient",
  "subtype.noEmail": "recipient",
  "subtype.suppressed": "reputation",
  "subtype.onAccountSuppressionList": "reputation",
  "subtype.transientGeneral": "transient",
  "subtype.mailboxFull": "transient",
  "subtype.messageTooLarge": "content",
  "subtype.contentRejected": "content",
  "subtype.attachmentRejected": "content",
  "subtype.undetermined": "unknown",
  "generic.permanent": "recipient",
  "generic.transient": "transient",
  "generic.undetermined": "unknown",
  "generic.unknown": "unknown",
  "complaint.abuse": "reputation",
  "complaint.authFailure": "policy",
  "complaint.fraud": "reputation",
  "complaint.notSpam": "reputation",
  "complaint.virus": "content",
  "complaint.other": "reputation",
};

/** Every key the resolvers can return; the test asserts catalog parity against it. */
export const BOUNCE_GUIDANCE_KEYS = Object.keys(CATEGORY_OF);

const CODE_TABLE: Record<string, string> = {
  "5.1.1": "code.noMailbox",
  "5.1.2": "code.badDomain",
  "5.2.1": "code.mailboxDisabled",
  "5.2.2": "code.mailboxFull",
  "4.2.2": "code.mailboxFull",
  "5.2.3": "code.messageTooLarge",
  "5.4.4": "code.dnsRouting",
  "5.7.1": "code.policyBlock",
  "5.7.26": "code.authFailure",
};

const SUBTYPE_TABLE: Record<string, string> = {
  "Permanent/General": "subtype.permanentGeneral",
  "Permanent/NoEmail": "subtype.noEmail",
  "Permanent/Suppressed": "subtype.suppressed",
  "Permanent/OnAccountSuppressionList": "subtype.onAccountSuppressionList",
  "Transient/General": "subtype.transientGeneral",
  "Transient/MailboxFull": "subtype.mailboxFull",
  "Transient/MessageTooLarge": "subtype.messageTooLarge",
  "Transient/ContentRejected": "subtype.contentRejected",
  "Transient/AttachmentRejected": "subtype.attachmentRejected",
  "Undetermined/General": "subtype.undetermined",
};

const GENERIC_TABLE: Record<string, string> = {
  Permanent: "generic.permanent",
  Transient: "generic.transient",
  Undetermined: "generic.undetermined",
};

const APPLE_RELAY = "privaterelay.appleid.com";
const APPLE_MAILBOX = new Set(["icloud.com", "me.com", "mac.com"]);
const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);
// Microsoft SmartScreen block markers appear in the diagnostic text, not as an
// RFC 3463 enhanced status.
const MICROSOFT_BLOCK_MARKERS = ["S3140", "S3150", "S3115"];

/** Provider hint keyed on recipient domain; highest precedence when matched. */
function matchProvider(
  domain: string | null,
  enhanced: string | null,
  diagnostic: string | null | undefined,
): string | null {
  if (!domain) return null;
  // Apple Private Relay always requires a registered, authenticated sender domain.
  if (domain === APPLE_RELAY) return "provider.apple";
  // iCloud family: only the auth/policy blocks map to the Apple hint; mailbox
  // problems (full, disabled) fall through to the enhanced-code table.
  if (APPLE_MAILBOX.has(domain) && enhanced?.startsWith("5.7.")) {
    return "provider.apple";
  }
  if (GOOGLE_DOMAINS.has(domain) && enhanced === "5.7.26") return "provider.googleBulk";
  if (
    MICROSOFT_DOMAINS.has(domain) &&
    diagnostic != null &&
    MICROSOFT_BLOCK_MARKERS.some((marker) => diagnostic.includes(marker))
  ) {
    return "provider.microsoftBlock";
  }
  return null;
}

function guidance(key: string, smtpCode: string | null): BounceGuidance {
  return { key, smtpCode, category: CATEGORY_OF[key] ?? "unknown" };
}

export function resolveBounceGuidance(input: ResolveBounceInput): BounceGuidance {
  const { display, enhanced } = parseSmtpDiagnostic(input.diagnosticCode);
  const domain = input.recipientDomain ? input.recipientDomain.trim().toLowerCase() : null;

  const provider = matchProvider(domain, enhanced, input.diagnosticCode);
  if (provider) return guidance(provider, display);

  if (enhanced) {
    const codeKey =
      CODE_TABLE[enhanced] ?? (enhanced.startsWith("4.7.") ? "code.greylisted" : null);
    if (codeKey) return guidance(codeKey, display);
  }

  if (input.bounceType && input.bounceSubType) {
    const subKey = SUBTYPE_TABLE[`${input.bounceType}/${input.bounceSubType}`];
    if (subKey) return guidance(subKey, display);
  }

  if (input.bounceType) {
    const genericKey = GENERIC_TABLE[input.bounceType];
    if (genericKey) return guidance(genericKey, display);
  }

  return guidance("generic.unknown", display);
}

/** ARF complaint feedback types (abuse, auth-failure, fraud, not-spam, virus, other). */
const COMPLAINT_TABLE: Record<string, string> = {
  abuse: "complaint.abuse",
  "auth-failure": "complaint.authFailure",
  fraud: "complaint.fraud",
  "not-spam": "complaint.notSpam",
  virus: "complaint.virus",
  other: "complaint.other",
};

export function resolveComplaintGuidance(feedbackType: string | null | undefined): {
  key: string;
  category: BounceCategory;
} {
  const key =
    (feedbackType && COMPLAINT_TABLE[feedbackType.trim().toLowerCase()]) || "complaint.other";
  return { key, category: CATEGORY_OF[key] ?? "reputation" };
}
