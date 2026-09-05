import { BlockList, isIP, isIPv6 } from "node:net";

/** Entries are IPs or CIDRs (the list better-auth consumes too); a malformed entry never matches. */
function proxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix] = entry.split("/");
    const family = isIPv6(address) ? "ipv6" : "ipv4";
    try {
      if (prefix === undefined) list.addAddress(address, family);
      else list.addSubnet(address, Number(prefix), family);
    } catch {
      // Not an address: the operator's typo must neither open nor close the walk.
    }
  }
  return list;
}

/**
 * Client address of a request that reached us through proxies. Cloud sits
 * behind Cloudflare only, which sets the single-value cf-connecting-ip;
 * self-host walks x-forwarded-for from the right past the operator's declared
 * proxies (each proxy appends the peer it accepted from, so the rightmost
 * untrusted entry is the real client). Null when nothing trustworthy is left.
 */
export function forwardedClientIp(
  headers: { get(name: string): string | null },
  opts: { cloud: boolean; trustedProxies: readonly string[] },
): string | null {
  if (opts.cloud) return headers.get("cf-connecting-ip")?.trim() || null;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const trusted = proxyList(opts.trustedProxies);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i] as string;
    // A hop that is not an address was not appended by a proxy, so nothing
    // to its left is trustworthy either.
    if (isIP(hop) === 0) return null;
    if (!trusted.check(hop, isIPv6(hop) ? "ipv6" : "ipv4")) return hop;
  }
  return null;
}
