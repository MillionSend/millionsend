import { getDomain } from "tldts";

/** A hostname as DNS compares it: lowercase, without the root's trailing dot. */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * The registrable domain under the ICANN section of the Public Suffix List:
 * the name a registry sold (acme.com.br for news.acme.com.br, acme.app.br
 * for mail.acme.app.br). Feeds DMARC lookups and link-domain checks, so
 * it must never stop at a public suffix. A name with no registrable part (an
 * IP, a bare suffix, a single label) comes back as is.
 */
export function registrableDomain(hostname: string): string {
  const name = normalizeHostname(hostname);
  return getDomain(name) ?? name;
}

/**
 * The registrable domain one owner holds, with the private section of the
 * list too: shop.eu.org, where registrableDomain says eu.org. What the
 * warm-up dates and counts by: the ICANN name above a free subdomain
 * service is the service's, years older than the names it hands out, and
 * shared by strangers. A name with no registrable part comes back as is.
 */
export function ownerDomain(hostname: string): string {
  const name = normalizeHostname(hostname);
  return getDomain(name, { allowPrivateDomains: true }) ?? name;
}

/**
 * The registrable domain when one owner holds everything under it. Null for
 * a bare public suffix, and where the private section of the list draws an
 * owner boundary below the ICANN answer (foo.eu.org, x.github.io): there the
 * ICANN name is shared by strangers, and vouching for it would hand the team
 * every brand under it.
 */
export function vouchedRegistrableDomain(hostname: string): string | null {
  const name = normalizeHostname(hostname);
  const icann = getDomain(name);
  return icann !== null && icann === getDomain(name, { allowPrivateDomains: true }) ? icann : null;
}

/** True when the hostname IS its registrable domain (apex send, no subdomain). */
export function isRootDomainSend(hostname: string): boolean {
  const name = normalizeHostname(hostname);
  return name === registrableDomain(name);
}
