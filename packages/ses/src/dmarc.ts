import {
  DNS_TIMEOUT_MS,
  type DnsResolver,
  dnsErrorStatus,
  nodeDnsResolver,
  withTimeout,
} from "./dns-check.js";

export type DmarcPolicy = "none" | "quarantine" | "reject";

/**
 * RFC 7489 tag=value list: must start with v=DMARC1; tags are case-insensitive
 * and whitespace-tolerant, trailing semicolons are legal. A record with no p=
 * tag or an unknown policy value is not a usable DMARC record.
 */
export function parseDmarcRecord(txt: string): { policy: DmarcPolicy } | null {
  const tags = txt.split(";").map((tag) => tag.trim());
  if (!/^v\s*=\s*dmarc1$/i.test(tags[0] ?? "")) return null;
  for (const tag of tags.slice(1)) {
    const match = /^p\s*=\s*(.+)$/i.exec(tag);
    if (!match) continue;
    const policy = (match[1] ?? "").trim().toLowerCase();
    return policy === "none" || policy === "quarantine" || policy === "reject" ? { policy } : null;
  }
  return null;
}

/** `name` is the `_dmarc.` label the record was found at: the send domain's, or the organizational domain's on fallback. */
export type DmarcLookup =
  | { status: "found"; policy: DmarcPolicy; name: string }
  | { status: "missing" | "unknown" };

/**
 * DMARC policy discovery (RFC 7489 §6.6.3): _dmarc at the send domain, falling
 * back to _dmarc at the organizational domain when no valid record exists at a
 * subdomain. CRITICAL: timeout/SERVFAIL/network errors read `unknown`, never
 * `missing` — a resolver blip must not look like an absent record (scores
 * would stamp permanent penalties on it).
 */
export async function lookupDmarc(
  domain: string,
  orgDomain: string,
  resolver: DnsResolver = nodeDnsResolver,
): Promise<DmarcLookup> {
  const sub = await lookupOne(`_dmarc.${domain}`, resolver);
  if (sub.status !== "missing" || orgDomain === domain) return sub;
  return lookupOne(`_dmarc.${orgDomain}`, resolver);
}

async function lookupOne(name: string, resolver: DnsResolver): Promise<DmarcLookup> {
  let rows: string[][];
  try {
    rows = await withTimeout(resolver.resolveTxt(name), DNS_TIMEOUT_MS);
  } catch (err) {
    return { status: dnsErrorStatus(err) };
  }
  // Long TXT values arrive chunked; the first valid v=DMARC1 answer wins.
  for (const chunks of rows) {
    const parsed = parseDmarcRecord(chunks.join(""));
    if (parsed) return { status: "found", policy: parsed.policy, name };
  }
  return { status: "missing" };
}
