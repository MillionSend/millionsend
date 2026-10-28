import { getDomain, getDomainWithoutSuffix } from "tldts";

/** A hostname as DNS compares it: lowercase, without the root's trailing dot. */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/** Whether `name` is `domain` itself or one of its subdomains; both already normalized. */
export function isDomainOrSubdomain(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`);
}

/** The last label of a hostname: its top-level domain. */
export function topLevelLabel(hostname: string): string {
  return hostname.slice(hostname.lastIndexOf(".") + 1);
}

const DOTTED_IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Whether a link's host (as the URL parser hands it over, so 2130706433 and
 * 0x7f.1 arrive as 127.0.0.1) is the reader's own machine, where a
 * developer's build left pointing at itself sends them: localhost and its
 * subdomains, 127.0.0.0/8, ::1 and 0.0.0.0. No sender can serve a page
 * there. A private network is left out, since a router or another device on
 * it answers a link, and so are an IPv6 address carrying a v4 part and the
 * testing and documentation names (.test, .example, .invalid): they get the
 * screening every other name gets.
 */
export function isLoopbackHost(hostname: string): boolean {
  const name = normalizeHostname(hostname);
  const v4 = DOTTED_IPV4.exec(name);
  if (v4) return name === "0.0.0.0" || Number(v4[1]) === 127;
  return name === "[::1]" || topLevelLabel(name) === "localhost";
}

/**
 * normalizeHostname, IDNA-encoded the way DNS and the domains table store
 * names (bücher.de → xn--bcher-kva.de); null when it is not a hostname. Only
 * letters, digits, dots and hyphens go to the URL parser: it would otherwise
 * read "a@b" as userinfo and percent-decode "%61".
 */
export function asciiHostname(hostname: string): string | null {
  const name = normalizeHostname(hostname.trim());
  if (!name || /[^\p{L}\p{M}\p{N}.-]/u.test(name)) return null;
  try {
    const ascii = new URL(`http://${name}`).hostname;
    return /^[a-z0-9.-]+$/.test(ascii) ? ascii : null;
  } catch {
    return null;
  }
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

/** The registrable domain an http(s) link points to; null for any other link or a malformed one. */
export function linkDomain(href: string): string | null {
  const url = href.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
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
 * The name a domain was registered under, without its suffix, the private
 * section of the list included: "acme" for mail.acme.com.br. Null for an IP
 * or a bare suffix.
 */
export function registeredName(hostname: string): string | null {
  return getDomainWithoutSuffix(normalizeHostname(hostname), { allowPrivateDomains: true });
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

/**
 * Whether the name is one a free host hands out under a parent strangers
 * share, as the private section of the suffix list draws it: x.pages.dev,
 * ref.supabase.co, app.up.railway.app. Not the parent itself, and not a
 * registered name of any depth.
 */
export function isFreeHostName(hostname: string): boolean {
  const name = normalizeHostname(hostname);
  return ownerDomain(name) !== registrableDomain(name);
}

/** True when the hostname IS its registrable domain (apex send, no subdomain). */
export function isRootDomainSend(hostname: string): boolean {
  const name = normalizeHostname(hostname);
  return name === registrableDomain(name);
}
