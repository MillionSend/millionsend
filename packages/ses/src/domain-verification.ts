// The pure subpath, never the barrel: the @millionsend/core index pulls modules
// that import @millionsend/config (env validation at import time), which this
// package and the worker cron must not require just to compute a status.
import {
  type DomainStatus,
  type LiveDnsStatus,
  recordCheck,
  strictDomainStatus,
} from "@millionsend/core/domain-status";
import { checkDnsRecords, type DnsResolver } from "./dns-check.js";
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
  liveDns: { type: string; name: string; value: string; status: LiveDnsStatus }[];
  records: TrackedDnsRecord[];
  /** SES's raw cached verification, so a caller can surface it without a second GetEmailIdentity. */
  verification: DomainVerification;
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

  const live = await checkDnsRecords(records, resolver);
  const liveDns = records.map((record, i) => ({
    type: record.type,
    name: record.name,
    value: record.value,
    status: live[i] ?? "missing",
  }));
  const status = strictDomainStatus(
    verification.dkimStatus,
    records.map((record, i) => ({ status: record.status, live: live[i] })),
  );
  return { status, liveDns, records, verification };
}
