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

/* Public resolvers are asked first, over DNS-over-HTTPS: the host's stub
   resolver may serve a record's previous value — or a cached absence — for
   as long as it likes (some providers clamp TTLs), and a check that keeps
   reporting a fixed record as wrong sends people re-pasting a correct value.
   HTTPS rather than UDP port 53 because a VPS drops and rate-limits UDP
   often enough that a one-shot lookup read present records as missing; the
   HTTPS path is the one every AWS call already takes. Both endpoints are
   asked at once and the first answer wins. */
const DOH_ENDPOINTS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];
const DOH_TIMEOUT_MS = 2500;
/* The public round's budget: one DoH timeout plus slack for the body. */
const PUBLIC_DNS_TIMEOUT_MS = 3000;
const RR_TYPE = { TXT: 16, MX: 15, CNAME: 5 } as const;
type RrType = keyof typeof RR_TYPE;

const dnsError = (code: "ENOTFOUND" | "ENODATA") => Object.assign(new Error(code), { code });

/** One DoH query. NXDOMAIN/NODATA throw the node:dns codes so every consumer classifies them alike. */
async function dohQuery(endpoint: string, name: string, type: RrType): Promise<string[]> {
  const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`doh ${res.status}`);
  const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
  if (body.Status === 3) throw dnsError("ENOTFOUND");
  if (body.Status !== 0) throw new Error(`doh rcode ${body.Status}`);
  // A CNAME chain rides along in Answer; keep only the type that was asked for.
  const data = (body.Answer ?? []).filter((a) => a.type === RR_TYPE[type]).map((a) => a.data);
  if (data.length === 0) throw dnsError("ENODATA");
  return data;
}

async function dohResolve(name: string, type: RrType): Promise<string[]> {
  try {
    return await Promise.any(DOH_ENDPOINTS.map((endpoint) => dohQuery(endpoint, name, type)));
  } catch (err) {
    // Every endpoint failed: a conclusive absence from any of them is the
    // verdict; otherwise the first failure carries on as inconclusive.
    const errors = err instanceof AggregateError ? err.errors : [err];
    throw errors.find((e) => dnsErrorStatus(e) === "missing") ?? errors[0];
  }
}

/** TXT wire form in DoH JSON: quoted strings, a long record split into several ("abc" "def"). */
export function parseTxtData(data: string): string[] {
  const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? "").replace(/\\(.)/g, "$1"),
  );
  return chunks.length > 0 ? chunks : [data];
}

/** MX wire form: "10 mail.example.com." */
export function parseMxData(data: string): { priority: number; exchange: string } {
  const [priority, exchange = ""] = data.trim().split(/\s+/);
  return { priority: Number(priority), exchange: exchange.replace(/\.$/, "") };
}

/**
 * NXDOMAIN/NODATA from the public resolvers is a conclusive answer and
 * propagates; anything else (egress blocked, timeout, SERVFAIL) falls back to
 * the system resolver so a locked-down self-host still checks.
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
      () => dohResolve(name, "TXT").then((rows) => rows.map(parseTxtData)),
      () => dnsResolveTxt(name),
    ),
  resolveMx: (name) =>
    resolvePublicFirst(
      () => dohResolve(name, "MX").then((rows) => rows.map(parseMxData)),
      () => dnsResolveMx(name),
    ),
  resolveCname: (name) =>
    resolvePublicFirst(
      () => dohResolve(name, "CNAME").then((rows) => rows.map((r) => r.replace(/\.$/, ""))),
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
// Covers the public round plus the system fallback behind it.
export const DNS_TIMEOUT_MS = 6000;

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
