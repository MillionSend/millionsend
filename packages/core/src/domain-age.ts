import { connect } from "node:net";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { getDomain } from "tldts";
import { normalizeHostname, ownerDomain } from "./org-domain.js";
import { DAY_MS } from "./utc-day.js";

/**
 * When a sending domain was registered, looked up off the send path (the
 * domain.age job) on the registrable name: RDAP through the IANA bootstrap,
 * then the registry's own WHOIS, then the first certificate in Certificate
 * Transparency, else unknown. A name a free subdomain service hands out
 * (ownerDomain) is no registry's: only its certificates can date it.
 */

/** Names MillionSend to every registry and log it asks. */
export const DOMAIN_AGE_USER_AGENT = "MillionSend-domain-age/1.0 (+https://millionsend.com)";

export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

/**
 * RDAP servers for popular ccTLDs the IANA bootstrap does not list. Not
 * IANA-registered: they answered with registration dates on 2026-10-09 but
 * may change without notice, so a failure falls through to WHOIS.
 */
const RDAP_OVERRIDES: Readonly<Record<string, string>> = {
  io: "https://rdap.identitydigital.services/rdap/",
  me: "https://rdap.identitydigital.services/rdap/",
  co: "https://rdap.registry.co/co/",
  us: "https://rdap.nic.us/",
};

const IANA_WHOIS = "whois.iana.org";
const CT_SEARCH_URL = "https://crt.sh/";
/** crt.sh serves about five requests a minute per address. */
export const CT_SPACING_MS = 12_000;
const LOOKUP_TIMEOUT_MS = 15_000;
const CT_TIMEOUT_MS = 30_000;
/** A Retry-After past this is read as this: one registry never parks the job for a day. */
const MAX_BACKOFF_MS = 6 * 3600_000;
/** A registry that says "slow down" in a WHOIS reply, which has no Retry-After. */
const WHOIS_THROTTLE_BACKOFF_MS = 3600_000;
const WHOIS_THROTTLED = /rate limit|quota exceeded|limit exceeded|too many (?:requests|queries)/i;
const WHOIS_MAX_BYTES = 1 << 20;

export type DomainAgeSource = (typeof schema.domainAgeSourceEnum.enumValues)[number];

export interface DomainAge {
  /** The registrable domain asked about; null when the name has none. */
  domain: string | null;
  registeredAt: Date | null;
  source: DomainAgeSource;
}

/** No source had a date and at least one failed in a way a later attempt can fix. */
export class DomainAgeRetryableError extends Error {
  override name = "DomainAgeRetryableError";
}

export interface DomainAgeDeps {
  fetch?: typeof fetch;
  /** One WHOIS exchange on TCP 43: the server's whole reply to `query`. */
  whois?: (server: string, query: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainAgeResolver {
  lookup(hostname: string): Promise<DomainAge>;
}

/** A step's answer: a date, a definite "none here", or a failure worth retrying. */
type Found = Date | null | "retry";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function utcDate(y: number, m: number, d: number, hh = 0, mi = 0, ss = 0): Date | null {
  const date = new Date(Date.UTC(y, m - 1, d, hh, mi, ss));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date
    : null;
}

const month = (name: string | undefined) =>
  MONTHS.indexOf((name ?? "").slice(0, 3).toLowerCase()) + 1;
const num = (part: string | undefined) => Number(part ?? 0);

/**
 * A registry's date string in any of the shapes RDAP and WHOIS servers use,
 * as UTC; null when it is none of them. A trailing zone name ("CLST") is
 * dropped: hours matter little against a 24-hour tier.
 */
export function parseRegistryDate(raw: string): Date | null {
  const s = raw.trim();
  let m =
    /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?/i.exec(
      s,
    );
  if (m) {
    const date = utcDate(num(m[1]), num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6]));
    const zone = m[7] && m[7].toUpperCase() !== "Z" ? m[7].replace(":", "") : null;
    if (!date || !zone) return date;
    const offset = (num(zone.slice(1, 3)) * 60 + num(zone.slice(3, 5))) * 60_000;
    return new Date(date.getTime() + (zone.startsWith("-") ? offset : -offset));
  }
  // 09/01/2003: day first, as European registries write it, unless it cannot be.
  m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/.exec(s);
  if (m) {
    const [day, mon] = num(m[2]) > 12 ? [m[2], m[1]] : [m[1], m[2]];
    return utcDate(num(m[3]), num(mon), num(day));
  }
  // 30th April 2003, 13-Dec-1994
  m = /^(\d{1,2})(?:st|nd|rd|th)?[- ]([a-z]{3,})[- ,]+(\d{4})/i.exec(s);
  if (m && month(m[2]) > 0) return utcDate(num(m[3]), month(m[2]), num(m[1]));
  // Tue Dec 12 2000, December 12, 2000
  m = /^(?:[a-z]{3},? )?([a-z]{3,}) (\d{1,2}),? (\d{4})/i.exec(s);
  if (m && month(m[1]) > 0) return utcDate(num(m[3]), month(m[1]), num(m[2]));
  return null;
}

const WHOIS_CREATED =
  /^[ \t]*(?:creation date|created(?: on)?|registered(?: on)?|registration (?:date|time)|domain registration date|record created|domain create date|first registration date)[ \t]*[:.]+[ \t]*(.+)$/im;
// .gg and .je: "Registered on 30th April 2003 at 00:00:00.000", no colon.
const WHOIS_REGISTERED_ON = /registered on (\d{1,2}(?:st|nd|rd|th)? [a-z]+ \d{4})/i;

/** The creation date in a registry's own WHOIS reply; null when it publishes none (.de, .eu). */
export function parseWhoisCreated(reply: string): Date | null {
  const raw = WHOIS_CREATED.exec(reply)?.[1] ?? WHOIS_REGISTERED_ON.exec(reply)?.[1];
  return raw ? parseRegistryDate(raw) : null;
}

/**
 * The WHOIS server IANA refers a TLD to. Only the "whois:" (or "refer:")
 * line is read: the TLD record also carries its own "created:", the date the
 * TLD was delegated (.de 1986), never the domain's.
 */
function parseIanaReferral(reply: string): string | null {
  return /^(?:refer|whois):[ \t]*(\S+)[ \t]*$/im.exec(reply)?.[1]?.toLowerCase() ?? null;
}

/** The registration event of an RDAP domain object. */
function rdapRegisteredAt(body: unknown): Date | null {
  const events = (body as { events?: { eventAction?: unknown; eventDate?: unknown }[] } | null)
    ?.events;
  const event = events?.find((e) => e.eventAction === "registration");
  return typeof event?.eventDate === "string" ? parseRegistryDate(event.eventDate) : null;
}

/** The earliest not_before among crt.sh's certificates for a name; null when it has none. */
function firstCertificateAt(rows: unknown): Date | null {
  if (!Array.isArray(rows)) return null;
  let first: Date | null = null;
  for (const row of rows as { not_before?: unknown }[]) {
    const at = typeof row.not_before === "string" ? parseRegistryDate(row.not_before) : null;
    if (at && (!first || at < first)) first = at;
  }
  return first;
}

/** Seconds or an HTTP date, as ms from `now`; a missing or odd value waits a minute. */
function retryAfterMs(header: string | null, now: number): number {
  const seconds = header && /^\d+$/.test(header.trim()) ? Number(header) * 1000 : null;
  const date = header && seconds === null ? Date.parse(header) - now : Number.NaN;
  const ms = seconds ?? (Number.isFinite(date) ? date : 60_000);
  return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

/** One WHOIS query over TCP 43, the reply read until the server closes. */
function whoisQuery(server: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = connect({ host: server, port: 43, timeout: LOOKUP_TIMEOUT_MS }, () => {
      socket.write(`${query}\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > WHOIS_MAX_BYTES) socket.destroy(new Error(`whois ${server}: reply too large`));
      else chunks.push(chunk);
    });
    socket.on("timeout", () => socket.destroy(new Error(`whois ${server}: timed out`)));
    socket.on("error", reject);
    socket.on("close", (hadError) => {
      if (!hadError) resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/**
 * The lookup chain with its caches: the RDAP bootstrap and IANA's WHOIS
 * referrals are refreshed daily, a host that answered 429 is left alone
 * until its Retry-After, and crt.sh is asked at most once per CT_SPACING_MS.
 * ponytail: the caches and the crt.sh clock are per process; with several
 * worker replicas each keeps its own, so crt.sh sees the replica count times
 * the rate.
 */
export function createDomainAgeResolver(deps: DomainAgeDeps = {}): DomainAgeResolver {
  const fetcher = deps.fetch ?? fetch;
  const whois = deps.whois ?? whoisQuery;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let bootstrap: { at: number; servers: Map<string, string> } | null = null;
  const referrals = new Map<string, { at: number; server: string | null }>();
  const backoff = new Map<string, number>();
  let ctAskedAt = Number.NEGATIVE_INFINITY;

  const held = (host: string) => (backoff.get(host) ?? 0) > now();

  async function get(url: string, timeoutMs: number): Promise<Response | "retry"> {
    const host = new URL(url).host;
    if (held(host)) return "retry";
    try {
      const res = await fetcher(url, {
        headers: {
          "user-agent": DOMAIN_AGE_USER_AGENT,
          accept: "application/rdap+json, application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        backoff.set(host, now() + retryAfterMs(res.headers.get("retry-after"), now()));
        return "retry";
      }
      return res;
    } catch {
      return "retry";
    }
  }

  async function json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /** TLD → RDAP base URL; a failed refresh keeps the last list. */
  async function rdapServers(): Promise<Map<string, string> | null> {
    if (bootstrap && now() - bootstrap.at < DAY_MS) return bootstrap.servers;
    const res = await get(RDAP_BOOTSTRAP_URL, LOOKUP_TIMEOUT_MS);
    const body =
      res !== "retry" && res.ok
        ? ((await json(res)) as { services?: [string[], string[]][] } | undefined)
        : undefined;
    if (!body?.services) return bootstrap?.servers ?? null;
    const servers = new Map<string, string>();
    for (const [tlds, urls] of body.services) {
      const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
      if (url) for (const tld of tlds) servers.set(tld.toLowerCase(), url);
    }
    bootstrap = { at: now(), servers };
    return servers;
  }

  async function rdap(domain: string, tld: string): Promise<Found> {
    const servers = await rdapServers();
    const base = servers?.get(tld) ?? RDAP_OVERRIDES[tld];
    if (!base) return servers ? null : "retry";
    const res = await get(`${base.replace(/\/?$/, "/")}domain/${domain}`, LOOKUP_TIMEOUT_MS);
    if (res === "retry") return "retry";
    if (res.status === 404) return null;
    if (!res.ok) return "retry";
    const body = await json(res);
    return body === undefined ? "retry" : rdapRegisteredAt(body);
  }

  async function referral(tld: string): Promise<string | null | "retry"> {
    const cached = referrals.get(tld);
    if (cached && now() - cached.at < DAY_MS) return cached.server;
    try {
      const server = parseIanaReferral(await whois(IANA_WHOIS, tld));
      referrals.set(tld, { at: now(), server });
      return server;
    } catch {
      return cached ? cached.server : "retry";
    }
  }

  async function registryWhois(domain: string, tld: string): Promise<Found> {
    const server = await referral(tld);
    if (server === null || server === "retry") return server;
    if (held(server)) return "retry";
    let reply: string;
    try {
      reply = await whois(server, domain);
    } catch {
      return "retry";
    }
    const created = parseWhoisCreated(reply);
    if (created || !WHOIS_THROTTLED.test(reply)) return created;
    backoff.set(server, now() + WHOIS_THROTTLE_BACKOFF_MS);
    return "retry";
  }

  async function certificateTransparency(domain: string): Promise<Found> {
    const wait = ctAskedAt + CT_SPACING_MS - now();
    if (wait > 0) await sleep(wait);
    ctAskedAt = now();
    const res = await get(
      `${CT_SEARCH_URL}?q=${encodeURIComponent(domain)}&output=json`,
      CT_TIMEOUT_MS,
    );
    if (res === "retry" || !res.ok) return "retry";
    const rows = await json(res);
    return rows === undefined ? "retry" : firstCertificateAt(rows);
  }

  /** A date a registry could have written: not before 1985, not in the future. */
  const plausible = (at: Date) =>
    at.getUTCFullYear() >= 1985 && at.getTime() <= now() + DAY_MS ? at : null;

  return {
    async lookup(hostname) {
      const sold = getDomain(normalizeHostname(hostname));
      if (!sold) return { domain: null, registeredAt: null, source: "unknown" };
      const domain = ownerDomain(hostname);
      const tld = domain.slice(domain.lastIndexOf(".") + 1);
      const steps = [
        ["rdap", () => rdap(domain, tld)],
        ["whois", () => registryWhois(domain, tld)],
        ["ct", () => certificateTransparency(domain)],
      ] as const;
      let retry = false;
      for (const [source, step] of domain === sold ? steps : steps.slice(2)) {
        const found = await step();
        if (found === "retry") retry = true;
        else if (found && plausible(found)) return { domain, registeredAt: found, source };
      }
      if (retry) throw new DomainAgeRetryableError(`${domain}: no source had a date, one failed`);
      return { domain, registeredAt: null, source: "unknown" };
    },
  };
}

/**
 * The domain.age job's write: the date and where it came from, stamped with
 * the check. An answer without a date never erases one found before, and a
 * certificate's never replaces a registry's: the certificate is only reached
 * when the registry lookups fail, and it can postdate the registration by
 * years. Returns what the row holds after the write, null when it is gone.
 */
export async function recordDomainAge(
  db: Db,
  resolver: DomainAgeResolver,
  domainId: string,
  now: Date = new Date(),
): Promise<DomainAge | null> {
  const d = schema.domains;
  const [domain] = await db
    .select({ name: d.name, registeredAt: d.registeredAt, ageSource: d.ageSource })
    .from(d)
    .where(eq(d.id, domainId));
  if (!domain) return null;
  const age = await resolver.lookup(domain.name);
  const registry = domain.ageSource === "rdap" || domain.ageSource === "whois";
  if (age.registeredAt && !(age.source === "ct" && registry)) {
    await db
      .update(d)
      .set({ registeredAt: age.registeredAt, ageSource: age.source, ageCheckedAt: now })
      .where(eq(d.id, domainId));
    return age;
  }
  await db
    .update(d)
    .set({ ageSource: sql`coalesce(${d.ageSource}, 'unknown')`, ageCheckedAt: now })
    .where(eq(d.id, domainId));
  return {
    domain: age.domain,
    registeredAt: domain.registeredAt,
    source: domain.ageSource ?? "unknown",
  };
}

/** A lookup that ran out of retries: checked, age unknown unless an earlier check found one. */
export async function markDomainAgeUnknown(
  db: Db,
  domainId: string,
  now: Date = new Date(),
): Promise<void> {
  const d = schema.domains;
  await db
    .update(d)
    .set({ ageSource: sql`coalesce(${d.ageSource}, 'unknown')`, ageCheckedAt: now })
    .where(eq(d.id, domainId));
}

/**
 * Domains no lookup has answered for, oldest first: rows from before the
 * job existed, and any whose job was lost. Past the job's own retries, so a
 * lookup still retrying is not asked twice.
 */
export async function domainsAwaitingAge(
  db: Db,
  now: Date = new Date(),
  limit = 100,
): Promise<string[]> {
  const d = schema.domains;
  const rows = await db
    .select({ id: d.id })
    .from(d)
    .where(and(isNull(d.ageCheckedAt), lt(d.createdAt, new Date(now.getTime() - 2 * 3600_000))))
    .orderBy(asc(d.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
