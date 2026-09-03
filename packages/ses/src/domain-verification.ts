// The pure subpath, never the barrel: the @millionsend/core index pulls modules
// that import @millionsend/config (env validation at import time), which this
// package and the worker cron must not require just to compute a status.
import {
  type DomainStatus,
  type LiveDnsStatus,
  recordCheck,
  strictDomainStatus,
} from "@millionsend/core/domain-status";
import { registrableDomain } from "@millionsend/core/org-domain";
import { type DmarcLookup, type DmarcPolicy, lookupDmarc } from "./dmarc.js";
import { checkDnsRecordsDetailed, type DnsResolver } from "./dns-check.js";
import {
  DKIM_SELECTOR,
  type DnsRecordGroup,
  type DomainVerification,
  dnsRecordsForDomain,
  getDomainVerification,
  type SesIdentityClient,
} from "./domain-identity.js";

/** A DNS checklist row with its SES-derived status; `null` = SES never checks it (DMARC). */
export interface TrackedDnsRecord {
  group: DnsRecordGroup;
  type: "MX" | "TXT";
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
}

export interface DomainVerificationResult {
  status: DomainStatus;
  liveDns: {
    type: string;
    name: string;
    value: string;
    status: LiveDnsStatus;
    /** On `mismatch`: what the name answered instead, one answer per line. */
    found?: string;
    /** The row's own name is empty but this parent record governs it (DMARC organizational-domain fallback). */
    inherited?: { name: string; policy: DmarcPolicy };
  }[];
  records: TrackedDnsRecord[];
  /** SES's raw cached verification, so a caller can surface it without a second GetEmailIdentity. */
  verification: DomainVerification;
  /** Per-record live verdicts in the domains.dns_records snapshot shape. */
  dnsRecords: { group: string; name: string; type: string; status: LiveDnsStatus }[];
  dmarc: DmarcLookup;
}

/**
 * THE single source of truth both the web verify mutation and the worker cron
 * use to decide a domain's send-gate status. Runs SES's cached verification,
 * builds the expected DNS checklist, live-checks every row, maps each to its
 * SES gate, and folds the two into the strict stored status.
 *
 * SECURITY: the send gate keys off the stored domains.status; running this on a
 * schedule is what demotes a verified domain back to `pending` when a required
 * record is removed after verification, without waiting for a page open.
 *
 * Covers exactly `dnsRecordsForDomain` (DKIM, MAIL FROM MX + SPF, DMARC) — the
 * complete set that determines status. The app-layer tracking CNAME is not
 * emitted here: its target is app-instance-specific and it never gates status,
 * so a display-only caller appends it separately.
 */
export async function computeDomainVerification(
  sesClient: SesIdentityClient,
  resolver: DnsResolver,
  domain: {
    name: string;
    region: string;
    mailFromSubdomain: string;
    dkimSelector: string | null;
    dkimPublicKey: string | null;
    trackingSubdomain: string | null;
  },
): Promise<DomainVerificationResult> {
  const verification = await getDomainVerification(sesClient, { domain: domain.name });
  const records: TrackedDnsRecord[] = dnsRecordsForDomain({
    domain: domain.name,
    // Columns are nullable only for bare fixture inserts; the create flow always
    // sets both. Falling back keeps a half-inserted row from throwing here.
    dkimSelector: domain.dkimSelector ?? DKIM_SELECTOR,
    dkimPublicKey: domain.dkimPublicKey ?? "",
    mailFromSubdomain: domain.mailFromSubdomain,
    region: domain.region,
  }).map((record) => ({
    ...record,
    // DMARC is recommended-only: SES never checks it, so it carries no state.
    status:
      record.group === "verification"
        ? recordCheck(verification.dkimStatus)
        : record.group === "sending"
          ? recordCheck(verification.mailFromStatus)
          : null,
  }));

  // DMARC skips the exact-name check and rides RFC 7489 §6.6.3 discovery
  // (send domain, then the organizational domain): a subdomain sender covered
  // by the apex record reads found, since that is the policy receivers apply
  // to it. One extra TXT query per verification, never per send — send-time
  // insights read the persisted snapshot instead.
  const checked = records.filter((record) => record.group !== "dmarc");
  const [checkedLive, dmarc] = await Promise.all([
    checkDnsRecordsDetailed(checked, resolver),
    lookupDmarc(domain.name, registrableDomain(domain.name), resolver),
  ]);
  const checks = records.map((record) =>
    record.group === "dmarc" ? { status: dmarc.status } : checkedLive[checked.indexOf(record)],
  );
  const live = checks.map((check) => check?.status);
  const liveDns = records.map((record, i) => ({
    type: record.type,
    name: record.name,
    value: record.value,
    status: live[i] ?? "missing",
    ...(checks[i]?.found ? { found: checks[i].found } : {}),
    ...(record.group === "dmarc" && dmarc.status === "found" && dmarc.name !== record.name
      ? { inherited: { name: dmarc.name, policy: dmarc.policy } }
      : {}),
  }));
  const dnsRecords = records.map((record, i) => ({
    group: record.group,
    name: record.name,
    type: record.type,
    status: live[i] ?? "unknown",
  }));
  const status = strictDomainStatus(
    verification.dkimStatus,
    records.map((record, i) => ({ status: record.status, live: live[i] })),
  );
  return { status, liveDns, records, verification, dnsRecords, dmarc };
}

/**
 * The domain-row columns every verification pass persists alongside
 * status/lastCheckedAt. An `unknown` DMARC lookup writes neither policy nor
 * checkedAt: an inconclusive check must not erase a known record. Likewise a
 * resolver outage (EVERY record `unknown`) skips the dnsRecords write —
 * clobbering the last good snapshot with all-unknown rows would destroy the
 * only conclusive picture consumers have; partial results still write.
 */
export function verificationDbPatch(
  result: Pick<DomainVerificationResult, "dnsRecords" | "dmarc">,
  now: Date,
): {
  dnsRecords?: DomainVerificationResult["dnsRecords"];
  dmarcPolicy?: DmarcPolicy | null;
  dmarcCheckedAt?: Date;
} {
  return {
    ...(result.dnsRecords.every((r) => r.status === "unknown")
      ? {}
      : { dnsRecords: result.dnsRecords }),
    ...(result.dmarc.status !== "unknown"
      ? {
          dmarcPolicy: result.dmarc.status === "found" ? result.dmarc.policy : null,
          dmarcCheckedAt: now,
        }
      : {}),
  };
}
