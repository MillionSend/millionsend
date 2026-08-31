/**
 * Multi-part public suffixes we recognize when finding the registrable
 * domain. Curated: the common ccTLD second-level suffixes our customers'
 * domains actually sit under.
 * ponytail: curated list, not the full Public Suffix List — wire in the PSL
 * if a customer's suffix ever falls outside it (worst case the Name pill
 * shows one extra label; the copied value still resolves at the provider).
 */
const MULTI_PART_SUFFIXES = new Set([
  "com.br",
  "net.br",
  "org.br",
  "com.au",
  "net.au",
  "org.au",
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.nz",
  "net.nz",
  "org.nz",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.tr",
  "co.za",
  "co.in",
  "co.kr",
  "com.cn",
  "com.tw",
  "com.hk",
  "com.sg",
  "com.my",
]);

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  const take = MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** True when the hostname IS its registrable domain (apex send, no subdomain). */
export function isRootDomainSend(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === registrableDomain(name);
}
