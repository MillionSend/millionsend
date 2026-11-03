import { Resolver } from "node:dns/promises";
import { recipientDomainCheckEnabled } from "@millionsend/config";
import { parse } from "tldts";
import { createFixedWindowLimiter } from "./domain-lifecycle.js";
import { SES_MAILBOX_SIMULATOR_DOMAIN } from "./mailbox-providers.js";
import { isDomainOrSubdomain, normalizeHostname, topLevelLabel } from "./org-domain.js";
import { createPromiseCache } from "./promise-cache.js";
import { parseSingleSender } from "./sender-address.js";
import { DAY_MS } from "./utc-day.js";

/**
 * Last labels no internet mail can reach: RFC 2606, RFC 6761, RFC 6762
 * (local), RFC 7686 (onion), RFC 9476 (alt) and ICANN's private-use
 * reservation (internal).
 */
const RESERVED_TLDS = new Set([
  "invalid",
  "test",
  "example",
  "localhost",
  "local",
  "onion",
  "alt",
  "internal",
]);

/** RFC 8375. The rest of .arpa stays allowed: uri.arpa and urn.arpa publish MX records. */
const HOME_ARPA = "home.arpa";

/** RFC 2606 §3; each publishes a null MX (RFC 7505). */
const DOCUMENTATION_DOMAINS = ["example.com", "example.net", "example.org"];

/** Distinct unknown TLDs one call looks up; any further ones pass. */
const MAX_TLD_LOOKUPS = 10;

const LOOKUP_DEADLINE_MS = 2_000;

export type UndeliverableReason = "reserved_name" | "documentation_domain" | "nonexistent_tld";

export interface UndeliverableRecipient {
  /** Position in the input. */
  index: number;
  /** The parsed addr-spec, lowercased: never the display-name form. */
  address: string;
  reason: UndeliverableReason;
}

/**
 * What a recipient domain alone says, with no DNS: a name no mail can ever
 * reach, `unknown_tld` when tldts doesn't know its TLD (only a root lookup
 * can settle that), or null. Reserved names come first, since tldts lists
 * onion and home.arpa as ICANN suffixes.
 */
export function classifyRecipientDomain(
  domain: string,
): UndeliverableReason | "unknown_tld" | null {
  const name = normalizeHostname(domain);
  const tld = topLevelLabel(name);
  if (RESERVED_TLDS.has(tld) || isDomainOrSubdomain(name, HOME_ARPA)) return "reserved_name";
  if (DOCUMENTATION_DOMAINS.some((d) => isDomainOrSubdomain(name, d))) {
    return "documentation_domain";
  }
  // RFC 3696 §2 rules out all-numeric TLDs; this also catches an unbracketed IPv4.
  if (/^\d+$/.test(tld)) return "nonexistent_tld";
  // isIcann is null for an IP or an invalid hostname, which pass: wire validation owns syntax.
  return parse(name).isIcann === false ? "unknown_tld" : null;
}

/**
 * Whether a TLD exists in the root zone, cached for a day. Only NXDOMAIN
 * says no; an answer or ENODATA says yes. Anything else, an over-budget miss
 * included, rejects and is not cached, so the caller lets the TLD pass.
 */
export function createTldExists(deps: {
  resolveNs: (name: string) => Promise<unknown>;
  now?: (() => number) | undefined;
  overBudget?: (() => boolean) | undefined;
}): (tld: string) => Promise<boolean> {
  const cache = createPromiseCache({
    maxEntries: 5000,
    ttlMs: DAY_MS,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return (tld) =>
    cache.get(tld, async () => {
      if (deps.overBudget?.()) throw new Error("DNS lookup budget spent");
      try {
        // Fully qualified, so the resolver never tries its search domains first.
        await deps.resolveNs(`${tld}.`);
        return true;
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "ENOTFOUND") return false;
        if (code === "ENODATA") return true;
        throw err;
      }
    });
}

const resolver = new Resolver({ timeout: 1_000, tries: 1 });
// Input-controlled names must not flood the host's resolver, which SES, KMS
// and S3 calls share; cached answers don't spend the budget.
const lookupBudget = createFixedWindowLimiter(100, 1_000);
const tldExists = createTldExists({
  resolveNs: (name) => resolver.resolveNs(name),
  overBudget: () => lookupBudget("dns") !== null,
});

/** The TLDs among `tlds` the root says don't exist; lookups that fail or outlast the deadline pass. */
async function missingTlds(
  tlds: string[],
  exists: (tld: string) => Promise<boolean>,
): Promise<Set<string>> {
  const missing = new Set<string>();
  const lookups = tlds.map(async (tld) => {
    if (!(await exists(tld))) missing.add(tld);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(lookups),
    new Promise((resolve) => {
      timer = setTimeout(resolve, LOOKUP_DEADLINE_MS);
    }),
  ]);
  clearTimeout(timer);
  // A copy: a lookup settling after the deadline must not refuse anything.
  return new Set(missing);
}

/**
 * The recipients whose domain can never receive mail, in input order.
 * Unparseable addresses pass: wire validation owns syntax. An input whose
 * TLDs tldts all knows never waits on DNS; otherwise the call waits for at
 * most one deadline. Callers with many items call it once for all of them.
 */
export async function undeliverableRecipients(
  addresses: readonly string[],
  opts: { tldExists?: ((tld: string) => Promise<boolean>) | undefined } = {},
): Promise<UndeliverableRecipient[]> {
  if (!recipientDomainCheckEnabled()) return [];
  const parsed = addresses.map((input) => {
    const mailbox = parseSingleSender(input);
    return mailbox ? { ...mailbox, verdict: classifyRecipientDomain(mailbox.domain) } : null;
  });
  const unknownTlds = [
    ...new Set(
      parsed.flatMap((p) => (p?.verdict === "unknown_tld" ? [topLevelLabel(p.domain)] : [])),
    ),
  ].slice(0, MAX_TLD_LOOKUPS);
  const missing =
    unknownTlds.length > 0
      ? await missingTlds(unknownTlds, opts.tldExists ?? tldExists)
      : new Set<string>();
  return parsed.flatMap((p, index) => {
    if (!p?.verdict) return [];
    const reason =
      p.verdict !== "unknown_tld"
        ? p.verdict
        : missing.has(topLevelLabel(p.domain))
          ? "nonexistent_tld"
          : null;
    return reason ? [{ index, address: p.address.toLowerCase(), reason }] : [];
  });
}

function whyUndeliverable(domain: string, reason: UndeliverableReason): string {
  switch (reason) {
    case "reserved_name": {
      const name = isDomainOrSubdomain(domain, HOME_ARPA) ? HOME_ARPA : `.${topLevelLabel(domain)}`;
      return `${name} is a reserved name that internet mail never reaches.`;
    }
    case "documentation_domain": {
      const name = DOCUMENTATION_DOMAINS.find((d) => isDomainOrSubdomain(domain, d)) ?? domain;
      return `${name} is reserved for documentation and accepts no mail.`;
    }
    case "nonexistent_tld":
      return `.${topLevelLabel(domain)} is not a top-level domain.`;
  }
}

/** The one English message for a refused recipient; `forSend` points at the SES mailbox simulator. */
export function undeliverableRecipientMessage(
  hit: { address: string; reason: UndeliverableReason },
  opts: { forSend?: boolean | undefined } = {},
): string {
  const domain = hit.address.slice(hit.address.lastIndexOf("@") + 1);
  const tip = opts.forSend
    ? ` To test sending without emailing anyone, use success@${SES_MAILBOX_SIMULATOR_DOMAIN}.`
    : "";
  return `${hit.address} can never receive mail: ${whyUndeliverable(domain, hit.reason)}${tip}`;
}
