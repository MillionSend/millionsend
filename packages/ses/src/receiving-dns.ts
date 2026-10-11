import { normalizeHostname } from "@millionsend/core/org-domain";
import {
  DNS_TIMEOUT_MS,
  type DnsResolver,
  dnsErrorStatus,
  type LiveDnsCheck,
  withTimeout,
} from "./dns-check.js";

/** The priority the Receiving record asks for (Resend's value). */
export const RECEIVING_MX_PRIORITY = 10;

/**
 * The record a receiving domain publishes: an MX at the domain's own name
 * pointing at RECEIVING_MX_HOST. Shown beside the sending records but never
 * part of the sending status.
 */
export function receivingDnsRecord(
  domainName: string,
  mxHost: string,
): { type: "MX"; name: string; value: string; priority: number } {
  return { type: "MX", name: domainName, value: mxHost, priority: RECEIVING_MX_PRIORITY };
}

/**
 * Live check of the Receiving record. `found` only when RECEIVING_MX_HOST is
 * among the domain's lowest-preference MX hosts: senders try those first, so
 * a lower-numbered MX elsewhere means mail never reaches ours. The priority
 * value itself is advice, not a requirement. On `mismatch`, `found` lists
 * what the name publishes instead, one "priority host" per line.
 */
export async function checkReceivingMx(
  domainName: string,
  mxHost: string,
  resolver: DnsResolver,
): Promise<LiveDnsCheck> {
  try {
    const rows = await withTimeout(resolver.resolveMx(domainName), DNS_TIMEOUT_MS);
    if (rows.length === 0) return { status: "missing" };
    const want = normalizeHostname(mxHost);
    const lowest = Math.min(...rows.map((r) => r.priority));
    if (rows.some((r) => r.priority === lowest && normalizeHostname(r.exchange) === want)) {
      return { status: "found" };
    }
    return {
      status: "mismatch",
      found: [...rows]
        .sort((a, b) => a.priority - b.priority)
        .map((r) => `${r.priority} ${normalizeHostname(r.exchange)}`)
        .join("\n"),
    };
  } catch (err) {
    // Never throws: NXDOMAIN/NODATA read missing, anything else unknown.
    return { status: dnsErrorStatus(err) };
  }
}
