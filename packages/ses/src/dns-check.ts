import {
  resolveCname as dnsResolveCname,
  resolveMx as dnsResolveMx,
  resolveTxt as dnsResolveTxt,
  Resolver,
} from "node:dns/promises";
import type { LiveDnsStatus } from "@millionsend/core/domain-status";

/** DNS access seam so callers inject a fake and tests hit no network. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveMx(hostname: string): Promise<{ priority: number; exchange: string }[]>;
  resolveCname(hostname: string): Promise<string[]>;
}

/* Public resolvers are asked first: the host's stub resolver may serve a
   record's previous value for as long as it likes (some providers clamp
   TTLs), and a check that keeps reporting a fixed record as wrong sends
   people re-pasting a correct value. Cloudflare and Google answer for any
   public zone and honour the zone's TTL. */
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"];
const PUBLIC_DNS_TIMEOUT_MS = 2500;
const publicResolver = new Resolver({ timeout: PUBLIC_DNS_TIMEOUT_MS, tries: 1 });
publicResolver.setServers(PUBLIC_DNS_SERVERS);

/**
 * NXDOMAIN/NODATA from the public resolver is a conclusive answer and
 * propagates; anything else (egress to port 53 blocked, timeout, SERVFAIL)
 * falls back to the system resolver so a locked-down self-host still checks.
 */
export async function resolvePublicFirst<T>(
  viaPublic: () => Promise<T>,
  viaSystem: () => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(viaPublic(), PUBLIC_DNS_TIMEOUT_MS);
  } catch (err) {
    if (dnsErrorStatus(err) === "missing") throw err;
    return viaSystem();
  }
}

export const nodeDnsResolver: DnsResolver = {
  resolveTxt: (name) =>
    resolvePublicFirst(
      () => publicResolver.resolveTxt(name),
      () => dnsResolveTxt(name),
    ),
  resolveMx: (name) =>
    resolvePublicFirst(
      () => publicResolver.resolveMx(name),
      () => dnsResolveMx(name),
    ),
  resolveCname: (name) =>
    resolvePublicFirst(
      () => publicResolver.resolveCname(name),
      () => dnsResolveCname(name),
    ),
};

export interface DnsCheckRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
}

// A stalled resolver must not hang the whole check; a timeout reads as unknown.
export const DNS_TIMEOUT_MS = 5000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("dns timeout")), ms).unref();
    }),
  ]);
}

const stripDot = (host: string) => host.toLowerCase().replace(/\.$/, "");

/**
 * NXDOMAIN/NODATA are conclusive absence; everything else (timeout, SERVFAIL,
 * network error) is inconclusive and stays a distinct `unknown`. Consumers
 * fold it in opposite directions: the send gate treats it like missing
 * (conservative-closed, combineRecordStatus) while DMARC persistence skips it
 * (conservative-open — a blip must never stamp a score penalty).
 */
export function dnsErrorStatus(err: unknown): "missing" | "unknown" {
  const code = (err as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA" ? "missing" : "unknown";
}

// TXT values are stored quoted ("v=DKIM1; …"); the wire strips the quotes and
// may split long values into chunks, so compare on the unquoted, rejoined,
// whitespace-collapsed form. Never lowercased: DKIM p= is case-sensitive base64.
const normTxt = (value: string) =>
  value
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** A record's live verdict; on `mismatch`, what the name answered instead (one answer per line). */
export interface LiveDnsCheck {
  status: LiveDnsStatus;
  found?: string;
}

const mismatch = (answers: string[]): LiveDnsCheck => ({
  status: "mismatch",
  found: answers.join("\n"),
});

async function checkOne(record: DnsCheckRecord, resolver: DnsResolver): Promise<LiveDnsCheck> {
  try {
    if (record.type === "MX") {
      const rows = await withTimeout(resolver.resolveMx(record.name), DNS_TIMEOUT_MS);
      if (rows.length === 0) return { status: "missing" };
      const want = stripDot(record.value);
      const match = rows.some(
        (r) =>
          stripDot(r.exchange) === want &&
          (record.priority === undefined || r.priority === record.priority),
      );
      return match
        ? { status: "found" }
        : mismatch(rows.map((r) => `${r.priority} ${stripDot(r.exchange)}`));
    }
    if (record.type === "CNAME") {
      const rows = await withTimeout(resolver.resolveCname(record.name), DNS_TIMEOUT_MS);
      if (rows.length === 0) return { status: "missing" };
      const want = stripDot(record.value);
      return rows.some((r) => stripDot(r) === want)
        ? { status: "found" }
        : mismatch(rows.map(stripDot));
    }
    const rows = await withTimeout(resolver.resolveTxt(record.name), DNS_TIMEOUT_MS);
    if (rows.length === 0) return { status: "missing" };
    const want = normTxt(record.value);
    const answers = rows.map((chunks) => normTxt(chunks.join("")));
    return answers.includes(want) ? { status: "found" } : mismatch(answers);
  } catch (err) {
    // Never throw: NXDOMAIN/NODATA read missing, anything else unknown.
    return { status: dnsErrorStatus(err) };
  }
}

/** Resolve every expected record in parallel, aligned to input order, with what a mismatch found. */
export function checkDnsRecordsDetailed(
  records: DnsCheckRecord[],
  resolver: DnsResolver,
): Promise<LiveDnsCheck[]> {
  return Promise.all(records.map((record) => checkOne(record, resolver)));
}

/** Statuses only — the shape single-record callers (the tracking CNAME) read. */
export async function checkDnsRecords(
  records: DnsCheckRecord[],
  resolver: DnsResolver,
): Promise<LiveDnsStatus[]> {
  return (await checkDnsRecordsDetailed(records, resolver)).map((check) => check.status);
}
