import { registrableDomain } from "@millionsend/core/org-domain";

/**
 * The record name as a DNS provider's Name field expects it: relative to the
 * registrable domain's zone ("send.teste" for send.teste.postomize.ai on
 * teste.postomize.ai), "@" for the zone apex. Names outside the zone pass
 * through unchanged.
 */
export function zoneRelativeName(recordName: string, domain: string): string {
  const zone = registrableDomain(domain);
  const name = recordName.toLowerCase().replace(/\.$/, "");
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : recordName;
}
