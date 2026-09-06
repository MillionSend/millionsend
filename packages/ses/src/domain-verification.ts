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

/**
 * One row of the domain's DNS checklist with every signal a surface renders:
 * the expected record, SES's gate on it, and the live verdict where a lookup ran.
 */
export interface DnsChecklistRow {
  group: DnsRecordGroup | "tracking";
  type: "MX" | "TXT" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  /** SES's verification of the row; `null` = SES never checks it (DMARC, tracking CNAME) or was not asked. */
  status: "verified" | "pending" | "failed" | null;
  live?: LiveDnsStatus;
  /** On a live mismatch: what the name answered instead, one answer per line. */
  found?: string;
  /** This name is empty but the parent record governs it (DMARC organizational-domain fallback). */
  inherited?: { name: string; policy: DmarcPolicy };
}

/** A live verdict addressed to its checklist row by type, name and value. */
export interface LiveDnsRow {
  type: string;
  name: string;
  value: string;
  status: LiveDnsStatus;
  found?: string | undefined;
  inherited?: { name: string; policy: DmarcPolicy } | undefined;
}

const rowKey = (row: { type: string; name: string; value: string }) =>
  `${row.type}\t${row.name}\t${row.value}`;

/**
 * THE one place the DNS checklist is assembled, so the dashboard table, the
 * public API and the verification pass describe a record identically.
 * `verification` null = SES not asked (a create response). `live` rows are
 * matched by type+name+value; a row with no entry carries no live verdict.
 * `dmarc` is RFC 7489 discovery for the DMARC row and wins over a live entry
 * for it. The tracking CNAME is app-layer (its target is per deployment and it
 * never gates status), so the caller decides whether the row exists.
 */
export function dnsChecklist(input: {
  domain: {
    name: string;
    region: string;
    mailFromSubdomain: string;
    dkimSelector: string | null;
    dkimPublicKey: string | null;
  };
  verification: DomainVerification | null;
  live?: LiveDnsRow[] | undefined;
  dmarc?: DmarcLookup | undefined;
  tracking?: { name: string; value: string } | null | undefined;
}): DnsChecklistRow[] {
  const { domain, verification, live = [], dmarc, tracking } = input;
  const rows: DnsChecklistRow[] = dnsRecordsForDomain({
    domain: domain.name,
    // Columns are nullable only for bare fixture inserts; the create flow
    // always sets both. Falling back keeps a half-inserted row from throwing.
    dkimSelector: domain.dkimSelector ?? DKIM_SELECTOR,
    dkimPublicKey: domain.dkimPublicKey ?? "",
    mailFromSubdomain: domain.mailFromSubdomain,
    region: domain.region,
  }).map((record) => ({
    ...record,
    // DMARC is recommended-only: SES never checks it, so it carries no state.
    status: !verification
      ? null
      : record.group === "verification"
        ? recordCheck(verification.dkimStatus)
        : record.group === "sending"
          ? recordCheck(verification.mailFromStatus)
          : null,
  }));
  if (tracking) {
    rows.push({
      group: "tracking",
      type: "CNAME",
      name: tracking.name,
      value: tracking.value,
      status: null,
    });
  }
  const liveByKey = new Map(live.map((row) => [rowKey(row), row]));
  return rows.map((row) => {
    if (row.group === "dmarc" && dmarc) {
      return {
        ...row,
        live: dmarc.status,
        ...(dmarc.status === "found" && dmarc.name !== row.name
          ? { inherited: { name: dmarc.name, policy: dmarc.policy } }
          : {}),
      };
    }
    const entry = liveByKey.get(rowKey(row));
    if (!entry) return row;
    return {
      ...row,
      live: entry.status,
      ...(entry.found ? { found: entry.found } : {}),
      ...(entry.inherited ? { inherited: entry.inherited } : {}),
    };
  });
}

export interface DomainVerificationResult {
  status: DomainStatus;
  liveDns: LiveDnsRow[];
  records: DnsChecklistRow[];
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
  // DMARC skips the exact-name check and rides RFC 7489 §6.6.3 discovery
  // (send domain, then the organizational domain): a subdomain sender covered
  // by the apex record reads found, since that is the policy receivers apply
  // to it. One extra TXT query per verification, never per send — send-time
  // insights read the persisted snapshot instead.
  const checked = dnsChecklist({ domain, verification }).filter((row) => row.group !== "dmarc");
  const [checks, dmarc] = await Promise.all([
    checkDnsRecordsDetailed(checked, resolver),
    lookupDmarc(domain.name, registrableDomain(domain.name), resolver),
  ]);
  const records = dnsChecklist({
    domain,
    verification,
    dmarc,
    live: checked.map((row, i) => ({
      type: row.type,
      name: row.name,
      value: row.value,
      ...(checks[i] ?? { status: "unknown" }),
    })),
  });
  const liveDns = records.map(({ type, name, value, live, found, inherited }) => ({
    type,
    name,
    value,
    status: live ?? "missing",
    ...(found ? { found } : {}),
    ...(inherited ? { inherited } : {}),
  }));
  const dnsRecords = records.map(({ group, name, type, live }) => ({
    group,
    name,
    type,
    status: live ?? "unknown",
  }));
  const status = strictDomainStatus(
    verification.dkimStatus,
    records.map(({ status, live }) => ({ status, live })),
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
