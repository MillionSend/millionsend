import type { domainStatusEnum } from "@millionsend/db/schema";

/** The stored `domains.status` the send gate keys off (verifySenderDomain). */
export type DomainStatus = (typeof domainStatusEnum.enumValues)[number];

/**
 * Live per-record DNS verdict, distinct from SES's cached verification status.
 * `found` = the expected record resolves; `mismatch` = the name answers but no
 * answer carries the expected value (a wrong/stale record); `missing` = the
 * name doesn't answer at all (removed record, NXDOMAIN, or lookup timeout).
 * This is the real-time signal that catches a record removed seconds ago, which
 * SES's GetEmailIdentity keeps reporting as verified until it re-checks.
 */
export type LiveDnsStatus = "found" | "missing" | "mismatch";

/** The single source-of-truth verdict a DNS record row shows in its Status cell. */
export type RecordStatus = "missing" | "mismatch" | "pending" | "verified";

/** AWS's second gate on a record: `undefined` for records SES never checks (DMARC, tracking CNAME). */
export type SesGate = "verified" | "pending";

/**
 * The per-row SES status a tracked record carries: `null` = SES never checks
 * this record. Maps to the second gate — a FAILED SES row is not a pass, so it
 * gates like `pending` (found per our DNS, still not verified by AWS).
 */
export function sesGateFromRecordStatus(
  status: "verified" | "pending" | "failed" | null,
): SesGate | undefined {
  if (status === null) return undefined;
  return status === "verified" ? "verified" : "pending";
}

/**
 * Combine our live DNS lookup with AWS's verification into one record verdict.
 * OUR DNS is the primary gate, AWS the second: a record passing our lookup but
 * still PENDING at AWS is not verified. Records with no AWS gate (DMARC,
 * tracking) are authoritative on our lookup alone.
 */
export function combineRecordStatus({
  live,
  sesGate,
}: {
  live: LiveDnsStatus | undefined;
  sesGate: SesGate | undefined;
}): RecordStatus {
  // Before our live lookup returns, fall back to AWS's known status (the
  // Check-DNS button's own spinner signals that a fresh check is running, so
  // rows don't need their own "checking" state). `verified` shows through;
  // everything else reads `pending` until the live result arrives.
  if (live === undefined) return sesGate === "verified" ? "verified" : "pending";
  if (live === "missing") return "missing";
  if (live === "mismatch") return "mismatch";
  // live === "found": our DNS passed — verified unless AWS is still pending.
  return sesGate === "pending" ? "pending" : "verified";
}

/** Per-record check state: SES's raw status → the row's tracked status. */
export function recordCheck(sesStatus: string): "verified" | "pending" | "failed" {
  if (sesStatus === "SUCCESS") return "verified";
  if (sesStatus === "FAILED") return "failed";
  return "pending";
}

/**
 * SECURITY: the send gate keys off the stored domains.status, so this is the
 * one place strictness is decided. A domain is `verified` ONLY when every
 * REQUIRED record (those SES checks — DKIM, MX, SPF; non-null SES status)
 * passes BOTH gates: our live DNS lookup found it AND SES verified it. Optional
 * records (DMARC, tracking CNAME; null SES status) never gate. A live-MISSING
 * SPF thus keeps the domain `pending` even when SES's mail-from reads success.
 * DKIM hard/temporary SES failures surface before the all-records check.
 *
 * `dkimStatus` is SES's raw DKIM status string (SUCCESS/PENDING/FAILED/
 * TEMPORARY_FAILURE/NOT_STARTED); only the two failure values short-circuit.
 */
export function strictDomainStatus(
  dkimStatus: string,
  records: { status: "verified" | "pending" | "failed" | null; live: LiveDnsStatus | undefined }[],
): DomainStatus {
  if (dkimStatus === "FAILED") return "failed";
  if (dkimStatus === "TEMPORARY_FAILURE") return "temporary_failure";
  const required = records.filter((r) => r.status !== null);
  const allVerified = required.every(
    (r) =>
      combineRecordStatus({ live: r.live, sesGate: sesGateFromRecordStatus(r.status) }) ===
      "verified",
  );
  return allVerified ? "verified" : "pending";
}
