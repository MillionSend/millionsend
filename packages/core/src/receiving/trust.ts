import type { ReceivedAuthDetail, ReceivedAuthentication } from "@millionsend/db/schema";
import type { SenderTrust } from "../inboxes/types.js";
import { registrableDomain } from "../org-domain.js";

/**
 * Who a received message's sender is to an inbox, strongest first. Only
 * authentication proves a domain; the From header alone proves nothing, and
 * a message with anything but one From field holding one mailbox is never
 * trusted, since parsers keep a different one than DMARC judged.
 */

const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export interface SenderAuth {
  /** The MX's folded verdicts (received_emails.authentication). */
  authentication: ReceivedAuthentication;
  /** The unfolded ones, null from an MX that predates them. */
  authDetail: ReceivedAuthDetail | null;
  /** The envelope sender, "" for <>. */
  mailFrom: string;
}

/**
 * Whether authentication ties the message to its From domain (relaxed, at
 * the organizational domain, DMARC's default), and whether it contradicts it.
 * Without the MX's detail, alignment is rebuilt from the folded verdicts and
 * the envelope sender. A p=none failure reads unauthenticated once the
 * detail exists: the owner of that domain did not ask for enforcement.
 */
export function authOutcome(p: SenderAuth & { from: string }): {
  aligned: boolean;
  failed: boolean;
} {
  const { authentication: auth, authDetail: detail } = p;
  const fromOrg = registrableDomain(domainOf(p.from));
  if (detail) {
    const dmarc = detail.dmarc.result;
    const spfAligned =
      auth.spf === "pass" &&
      detail.spf.domain !== null &&
      registrableDomain(detail.spf.domain) === fromOrg;
    const aligned =
      dmarc === "pass" || (dmarc === "none" && (detail.dkim.aligned.length > 0 || spfAligned));
    const failed =
      (dmarc === "fail" &&
        (detail.dmarc.policy === "quarantine" || detail.dmarc.policy === "reject")) ||
      (dmarc === "none" && auth.spf === "fail" && detail.dkim.aligned.length === 0);
    return { aligned, failed };
  }
  const spfAligned =
    auth.spf === "pass" && p.mailFrom !== "" && registrableDomain(domainOf(p.mailFrom)) === fromOrg;
  const aligned = auth.dkim === "pass" || auth.dmarc === "pass" || spfAligned;
  // A residual dmarc "fail" is an enforcing policy that failed, or a p=none
  // domain whose message passed nothing at all: both contradict From.
  const failed =
    !aligned && (auth.dmarc === "fail" || (auth.spf === "fail" && auth.dkim !== "pass"));
  return { aligned, failed };
}

/** Allowlist entries: "local@domain" exactly (plus tags as written), or "*@domain" for it and its subdomains. */
export function allowlisted(address: string, allowlist: readonly string[]): boolean {
  const a = address.toLowerCase();
  const d = domainOf(a);
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith("*@")) {
      const domain = e.slice(2);
      return d === domain || d.endsWith(`.${domain}`);
    }
    return e === a;
  });
}

/**
 * The tier, first match winning: failed beats everything, so a spoofed
 * owner never rides a lower rule, and a From only the MX's parser could
 * read still fails on the verdict DMARC reached for it; owners and the
 * allowlist need alignment; a reply in a thread we proved (token or SES id)
 * from one of its participants needs none.
 */
export function senderTrust(
  p: SenderAuth & {
    /** The bare From address, lowercase; "" when the message has none. */
    from: string;
    fromFields: number;
    fromMailboxes: number;
    /** Team members' login addresses and the inbox's owner_addresses, lowercase. */
    owners: readonly string[];
    allowlist: readonly string[];
    thread?: { proven: boolean; participants: readonly string[] } | null | undefined;
  },
): SenderTrust {
  const { aligned, failed } = authOutcome(p);
  if (failed) return "failed";
  if (!p.from) return "unauthenticated";
  const from = p.from.toLowerCase();
  // The MX ran DMARC on the From domain its own parser found: when that is
  // not the domain read here, the two parsers disagree on who wrote it.
  const single =
    p.fromFields === 1 &&
    p.fromMailboxes === 1 &&
    (p.authDetail === null || p.authDetail.dmarc.domain === domainOf(from));
  if (single && aligned && p.owners.includes(from)) return "owner";
  if (single && aligned && allowlisted(from, p.allowlist)) return "allowlisted";
  if (single && p.thread?.proven && p.thread.participants.includes(from)) return "known_thread";
  if (single && aligned) return "external";
  return "unauthenticated";
}
