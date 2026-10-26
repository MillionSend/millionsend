import { getDomain } from "tldts";

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

/** RFC 8375. The rest of .arpa stays allowed: uri.arpa and urn.arpa publish MX records. */
export const HOME_ARPA = "home.arpa";

/** Last labels only the reader's own device or network resolves: RFC 6761, RFC 6762 (mDNS) and ICANN's private-use reservation. */
const LOCAL_TLDS: ReadonlySet<string> = new Set(["localhost", "local", "internal"]);

const DOTTED_IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

/**
 * Whether a link's host (as the URL parser hands it over, so 2130706433 and
 * 0x7f.1 arrive as 127.0.0.1) can only lead the reader to their own machine
 * or private network, where a developer's build left pointing at itself
 * sends them: a loopback or private address, or a name only those resolve
 * (localhost and its subdomains, .local, .internal, home.arpa). No sender can
 * serve a page there. Link-local addresses are left out (a cloud metadata
 * endpoint lives there, no test server does), and so is an IPv6 address
 * carrying a v4 part, since a browser reaches the public v4 it embeds; so
 * are the testing and documentation names (.test, .example, .invalid), which
 * get the screening every other name gets.
 */
export function isLocalAddressHost(hostname: string): boolean {
  const name = normalizeHostname(hostname);
  const v4 = DOTTED_IPV4.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      name === "0.0.0.0" ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (name.startsWith("[")) {
    const v6 = name.slice(1, -1);
    // ::1 and fc00::/7, the unique local range.
    return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6);
  }
  return LOCAL_TLDS.has(topLevelLabel(name)) || isDomainOrSubdomain(name, HOME_ARPA);
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
