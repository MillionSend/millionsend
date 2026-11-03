import type { ReceivedAuthentication, ReceivedHiddenText } from "@millionsend/db/schema";
import { isShortener } from "../email-insights.js";
import type { SenderTrust, SpamVerdict } from "../inboxes/types.js";
import type { BodyLink } from "../links.js";
import { registrableDomain } from "../org-domain.js";

/**
 * A local spam score from facts already in hand at ingest: no DNS
 * blocklist (the free mirrors exclude commercial use) and no network at
 * all. Every hit records a reason id. The weights are starting values,
 * stored with the verdict so they can be tuned on real mail.
 */

const FAIL_AT = 50;
const GRAY_AT = 25;
const HIDDEN_TEXT_CHARS = 200;
const INVISIBLE_CHARS = 20;
const DANGEROUS_ATTACHMENT =
  /\.(?:exe|scr|js|vbs|bat|cmd|com|pif|jar|iso|img|lnk|hta|msi|docm|xlsm|pptm|html?)$/i;
const ADDRESS = /[^\s<>"'@,;:()]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const DOMAIN_IN_TEXT = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;
const IP_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

export interface SpamInput {
  tier: SenderTrust;
  authentication: ReceivedAuthentication;
  helo: string;
  /** This instance's MX host: a client naming it in HELO forges it. */
  mxHost?: string | null | undefined;
  /** The domains of the recipients this delivery reached. */
  recipientDomains: readonly string[];
  /** The envelope sender, "" for <>. */
  mailFrom: string;
  /** A delivery status or feedback report (multipart/report). */
  report: boolean;
  hasDate: boolean;
  hasMessageId: boolean;
  from: string;
  fromName: string;
  replyTo: readonly string[];
  hiddenText: ReceivedHiddenText | null;
  links: readonly BodyLink[];
  attachmentNames: readonly (string | null)[];
}

const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

function hostOf(href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function spamVerdict(i: SpamInput): {
  verdict: SpamVerdict;
  score: number;
  reasons: string[];
} {
  const hits: [string, number][] = [];
  const hit = (reason: string, points: number) => hits.push([reason, points]);
  const auth = i.authentication;
  if (i.tier === "failed") hit("failed_auth", 40);
  if (auth.spf === "fail") hit("spf_fail", 15);
  else if (auth.spf === "softfail") hit("spf_softfail", 5);
  if (auth.dkim === "fail") hit("dkim_fail", 10);
  if (
    auth.spf !== "pass" &&
    auth.dkim !== "pass" &&
    auth.dkim !== "policy" &&
    auth.dmarc !== "pass" &&
    (i.tier === "unauthenticated" || i.tier === "failed")
  ) {
    hit("no_auth", 15);
  }
  const helo = i.helo.toLowerCase().replace(/\.$/, "");
  if (IP_HOST.test(helo) || !helo.includes(".")) hit("helo_bare", 10);
  else if (
    (i.mxHost && helo === i.mxHost.toLowerCase()) ||
    i.recipientDomains.some((d) => d.toLowerCase() === helo)
  ) {
    hit("helo_forged", 20);
  }
  if (i.mailFrom === "" && !i.report) hit("null_sender", 10);
  if (!i.hasDate) hit("no_date", 5);
  if (!i.hasMessageId) hit("no_message_id", 5);
  const from = i.from.toLowerCase();
  if ([...i.fromName.matchAll(ADDRESS)].some((m) => m[0].toLowerCase() !== from)) {
    hit("display_name_address", 25);
  }
  const fromOrg = from ? registrableDomain(domainOf(from)) : null;
  if (fromOrg && i.replyTo.some((r) => registrableDomain(domainOf(r)) !== fromOrg)) {
    hit("reply_to_mismatch", 5);
  }
  const hidden = i.hiddenText;
  if (hidden) {
    if (hidden.chars - hidden.preview_chars >= HIDDEN_TEXT_CHARS) hit("hidden_text", 15);
    if (hidden.invisible_chars >= INVISIBLE_CHARS) hit("invisible_chars", 10);
    if (hidden.flags.includes("alternative_mismatch")) hit("alternative_mismatch", 10);
  }
  let shortener = false;
  let ipLink = false;
  let anchorMismatch = false;
  for (const link of i.links) {
    const host = hostOf(link.href);
    if (host && isShortener(host)) {
      shortener = true;
    }
    if (host && IP_HOST.test(host)) ipLink = true;
    const lands = hostOf(link.url);
    if (lands && !IP_HOST.test(lands)) {
      const target = registrableDomain(lands);
      for (const m of link.text.matchAll(DOMAIN_IN_TEXT)) {
        const named = m[1] as string;
        // A file name (invoice.pdf) is no domain the reader would trust.
        if (
          !/\.(?:pdf|zip|docx?|xlsx?|png|jpe?g|gif|html?)$/i.test(named) &&
          registrableDomain(named) !== target
        ) {
          anchorMismatch = true;
        }
      }
    }
  }
  if (shortener) hit("shortener", 10);
  if (ipLink) hit("ip_link", 15);
  if (anchorMismatch) hit("anchor_domain_mismatch", 20);
  if (i.attachmentNames.some((name) => name !== null && DANGEROUS_ATTACHMENT.test(name))) {
    hit("dangerous_attachment", 30);
  }
  const score = Math.min(
    100,
    hits.reduce((sum, [, points]) => sum + points, 0),
  );
  return {
    verdict: score >= FAIL_AT ? "fail" : score >= GRAY_AT ? "gray" : "pass",
    score,
    reasons: hits.map(([reason]) => reason),
  };
}
