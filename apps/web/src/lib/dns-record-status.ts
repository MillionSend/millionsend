export type LiveDnsStatus = "found" | "missing" | "mismatch";

/** The single source-of-truth verdict a DNS record row shows in its Status cell. */
export type RecordStatus = "checking" | "missing" | "mismatch" | "pending" | "verified";

/** AWS's second gate on a record: `undefined` for records SES never checks (DMARC, tracking CNAME). */
export type SesGate = "verified" | "pending";

/**
 * The per-row SES status buildTrackedRecords emits: `null` = SES never checks
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
  if (live === undefined) return "checking";
  if (live === "missing") return "missing";
  if (live === "mismatch") return "mismatch";
  // live === "found": our DNS passed — verified unless AWS is still pending.
  return sesGate === "pending" ? "pending" : "verified";
}
