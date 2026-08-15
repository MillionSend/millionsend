import {
  resolveCname as dnsResolveCname,
  resolveMx as dnsResolveMx,
  resolveTxt as dnsResolveTxt,
} from "node:dns/promises";
import type { LiveDnsStatus } from "@millionsend/core/domain-status";

/** DNS access seam so callers inject a fake and tests hit no network. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveMx(hostname: string): Promise<{ priority: number; exchange: string }[]>;
  resolveCname(hostname: string): Promise<string[]>;
}

export const nodeDnsResolver: DnsResolver = {
  resolveTxt: (name) => dnsResolveTxt(name),
  resolveMx: (name) => dnsResolveMx(name),
  resolveCname: (name) => dnsResolveCname(name),
};

export interface DnsCheckRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
}

// A stalled resolver must not hang the whole check; a timeout reads as missing.
const DNS_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("dns timeout")), ms).unref();
    }),
  ]);
}

const stripDot = (host: string) => host.toLowerCase().replace(/\.$/, "");

// TXT values are stored quoted ("v=DKIM1; …"); the wire strips the quotes and
// may split long values into chunks, so compare on the unquoted, rejoined,
// whitespace-collapsed form. Never lowercased: DKIM p= is case-sensitive base64.
const normTxt = (value: string) =>
  value
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();

async function checkOne(record: DnsCheckRecord, resolver: DnsResolver): Promise<LiveDnsStatus> {
  try {
    if (record.type === "MX") {
      const rows = await withTimeout(resolver.resolveMx(record.name), DNS_TIMEOUT_MS);
      if (rows.length === 0) return "missing";
      const want = stripDot(record.value);
      const match = rows.some(
        (r) =>
          stripDot(r.exchange) === want &&
          (record.priority === undefined || r.priority === record.priority),
      );
      return match ? "found" : "mismatch";
    }
    if (record.type === "CNAME") {
      const rows = await withTimeout(resolver.resolveCname(record.name), DNS_TIMEOUT_MS);
      if (rows.length === 0) return "missing";
      const want = stripDot(record.value);
      return rows.some((r) => stripDot(r) === want) ? "found" : "mismatch";
    }
    const rows = await withTimeout(resolver.resolveTxt(record.name), DNS_TIMEOUT_MS);
    if (rows.length === 0) return "missing";
    const want = normTxt(record.value);
    return rows.some((chunks) => normTxt(chunks.join("")) === want) ? "found" : "mismatch";
  } catch {
    // NXDOMAIN / NODATA / timeout — the record isn't answering, never throw.
    return "missing";
  }
}

/** Resolve every expected record's live status in parallel, aligned to input order. */
export function checkDnsRecords(
  records: DnsCheckRecord[],
  resolver: DnsResolver,
): Promise<LiveDnsStatus[]> {
  return Promise.all(records.map((record) => checkOne(record, resolver)));
}
