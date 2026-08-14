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

function registrableDomain(domain: string): string {
  const labels = domain.split(".");
  const take = MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * The record name as a DNS provider's Name field expects it: relative to the
 * registrable domain's zone ("send.teste" for send.teste.postomize.ai on
 * teste.postomize.ai), "@" for the zone apex. Names outside the zone pass
 * through unchanged.
 */
export function zoneRelativeName(recordName: string, domain: string): string {
  const zone = registrableDomain(domain.toLowerCase().replace(/\.$/, ""));
  const name = recordName.toLowerCase().replace(/\.$/, "");
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : recordName;
}
