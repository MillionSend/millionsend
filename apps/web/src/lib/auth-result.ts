import type { ReceivedAuthDetail } from "@millionsend/db/schema";
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

/**
 * Why a check reads gray, as a key under inboxes.gray; null for a verdict
 * that needs no explaining. The unfolded detail tells a DMARC pass under
 * p=none from a fail the domain does not ask to block, which the folded
 * word "none" alone cannot.
 */
export function grayExplanation(
  check: AuthCheck,
  folded: string,
  detail: ReceivedAuthDetail | null,
):
  | "dmarcPassNone"
  | "dmarcFailNone"
  | "dmarcNoRecord"
  | "dmarcGeneric"
  | "dkimPolicy"
  | "spfSoftfail"
  | "spfNeutral"
  | "checkError"
  | null {
  if (check === "arc") return null;
  if (folded === "temperror" || folded === "permerror") return "checkError";
  if (check === "spf") {
    if (folded === "softfail") return "spfSoftfail";
    return folded === "neutral" || folded === "none" ? "spfNeutral" : null;
  }
  if (check === "dkim") return folded === "policy" ? "dkimPolicy" : null;
  if (folded !== "none") return null;
  if (detail?.dmarc.policy === null) return "dmarcNoRecord";
  if (detail?.dmarc.policy === "none") {
    if (detail.dmarc.result === "pass") return "dmarcPassNone";
    if (detail.dmarc.result === "fail") return "dmarcFailNone";
  }
  return "dmarcGeneric";
}

// The tiers core's senderTrust grants only on alignment with the From domain;
// a known thread's proof is the thread, not the domain.
const AUTHENTICATED_TRUST: ReadonlySet<string> = new Set(["owner", "allowlisted", "external"]);

/** Whether authentication (DMARC, or aligned DKIM or SPF) ties received mail to its From domain. */
export function authenticatedSender(trust: string | null | undefined): boolean {
  return trust != null && AUTHENTICATED_TRUST.has(trust);
}

/** The d= domains of DKIM-Signature header values (one per line), minus the From domain. */
export function dkimSignerDomains(signatures: string, fromDomain: string): string[] {
  const domains = [...signatures.matchAll(/(?:^|;)\s*d=([^;\s]+)/gim)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
  return [...new Set(domains)].filter((domain) => domain && domain !== fromDomain);
}
