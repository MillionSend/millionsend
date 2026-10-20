import { sharedInboxDomain } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { MediaIssue } from "./abuse-judge/media.js";
import {
  inFirstWindow,
  isHoldVerdict,
  loadMonitorState,
  MONITOR_HOLD_CATEGORIES,
  MONITOR_HOLD_REASONS,
  type MonitorDeps,
  type MonitorTier,
  monitorRowWithHistory,
  monitorTier,
  recordMonitorSample,
  YOUNG_DOMAIN_DAYS,
} from "./abuse-monitor.js";
import { countDistinctRecipients } from "./accept-email.js";
import type { DomainAgeResolver } from "./domain-age.js";
import { SHORTENER_HOSTS } from "./email-insights.js";
import { addressKey } from "./inboxes/compose.js";
import { threadSenders } from "./inboxes/send.js";
import { isSharedInboxSender } from "./inboxes/send-policy.js";
import {
  extractLinks,
  type ResolvedLink,
  resolveTextUrl,
  UNRESOLVED_DESTINATION,
} from "./links.js";
import type { MonitorSettings } from "./monitor-settings.js";
import { ownerDomain, registrableDomain } from "./org-domain.js";
import { releaseQuota } from "./quota.js";
import { teamMemberEmails } from "./receiving/inbox-routing.js";
import { parseSingleSender } from "./sender-address.js";
import { fetchTeamQuota } from "./team-plan.js";
import { DAY_MS, nextUtcDayStart, utcDay } from "./utc-day.js";

/**
 * Screening before SES: which mail waits for the judge's verdict before it
 * is sent, and what it does while it waits. The send handler asks on every
 * pass; the judge re-queues the send once the verdict lands, and the hold,
 * the pause and the parks the verdict brings are read on the next pass.
 */

/**
 * Why an email is judged before SES: its team is in its first window, it
 * carries a destination its team has not cleared, its team is new and it
 * carries files or rides in images, or it is cold shared-domain mail
 * (coldSharedSend).
 */
export type ScreenReason = "first_window" | "destination" | "media" | "recipient";

/** What the send path read of an email's body and files, locally: nothing fetched. */
export interface SendMedia {
  attachments: number;
  /** opaqueFacts: images, files or QR art carry the message, not its text. */
  opaque: boolean;
  /** URLs read from the files: QR codes, PDF, Office and calendar links. */
  links: readonly string[];
  /** A file the policy flags, that won't open, or that the API now refuses. */
  unsafe: boolean;
}

/**
 * A phishing-type verdict that held nothing waits this long before it is
 * sent: a burst reaches the repeat hold's count within it, so nothing of it
 * goes out.
 */
export const SCREEN_HOLD_WAIT_MS = 2 * 60_000;
/** While the judge fails on a young domain's mail it is re-run this often, this many times. */
export const SCREEN_RETRY_MS = 2 * 60_000;
export const SCREEN_RETRIES = 3;
/** Mail waits on a screening call: a short timeout, and one retry, beat the outage path. */
export const SCREEN_JUDGE_TIMEOUT_MS = 5_000;
/** A screening sample still pending after this lost its job; the next pass queues it again. */
const SCREEN_STALE_MS = 10 * 60_000;
/** A team's screening samples waiting on the judge at once; past it more mail waits its turn. */
export const SCREEN_OUTSTANDING_MAX = 20;
/** More new destinations than this in one message are not judged: an operator decides. */
export const NOVEL_DESTINATIONS_MAX = 20;
/** A team's daily screenings of mail for its new destinations; past it such mail waits a day. */
export const DESTINATION_SCREENS_PER_DAY = 200;
/**
 * A verdict clears a message's new destinations only under this score,
 * naming nothing phishing-type, and only when they are this many at most.
 */
export const DESTINATION_CLEAR_BELOW = 70;
export const DESTINATIONS_CLEARED_MAX = 5;
/** For this long after a destination clears, every email to it is judged after sending. */
export const DESTINATION_PROBATION_DAYS = 7;
/** Link-age lookups one verdict waits on; the rest are looked up in the background. */
export const LINK_AGE_LOOKUPS_PER_VERDICT = 3;
/** A failed link-age lookup is not asked again for this long. */
const LINK_AGE_FAILED_TTL_MS = 3600_000;
const LINK_AGE_BACKLOG_MAX = 1_000;

/** Park reasons the drain never releases: only an operator does, from the review list. */
export const OPERATOR_PARK_REASONS = ["screening", "destination", "media", "recipient"] as const;
export type ScreenParkReason = (typeof OPERATOR_PARK_REASONS)[number];

const MEDIA_PARKS_NEW: ReadonlySet<string> = new Set<MediaIssue>([
  "risky_file",
  "refused_file",
  "unreadable_file",
  "qr_undecoded",
  "vision_refused",
]);

/**
 * Whether what the judge could not clear in an email's images and files
 * parks the mail waiting on its verdict: for a team in new, a flagged,
 * refused or unreadable file, a QR code seen but not decoded, or a refused
 * read; for any team, images the reader's provider blocked.
 */
export function mediaParks(issues: readonly string[] | null, tier: MonitorTier): boolean {
  return (issues ?? []).some(
    (issue) => issue === "vision_blocked" || (tier === "new" && MEDIA_PARKS_NEW.has(issue)),
  );
}

/** A cached link age without a date is asked again after this. */
const LINK_AGE_UNKNOWN_TTL_MS = DAY_MS;

const ms = schema.monitorSamples;
const e = schema.emails;
const td = schema.teamDestinations;

type Sample = typeof schema.monitorSamples.$inferSelect;

/** A shortener's domain: it hides where a link leads, so it is never cleared. */
export function isShortener(domain: string): boolean {
  return [...SHORTENER_HOSTS].some((s) => domain === s || domain.endsWith(`.${s}`));
}

// What a link can resolve to: a DNS name (URL hands IDNs over in punycode),
// or an address. A merge field still in a template is neither.
const LINK_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;

/**
 * Where a message sends its reader: the owner domain (ownerDomain, so a free
 * host's x.pages.dev is its own) of every link a mail client would follow
 * (extractLinks: anchors, image-map areas, form actions, SVG links and the
 * URLs clients link in the text, each resolved as a browser resolves it and
 * read through redirect wrappers), of `links`, the URLs read from its
 * images and files, and of each Reply-To address; less the team's verified
 * domains and `ignore` (the platform's own hosts: unsubscribe and tracking
 * links). A link that leads nowhere this can read counts as
 * UNRESOLVED_DESTINATION, so the mail is screened. Each once, sorted.
 *
 * A verified domain owns what shares its owner domain, which the suffix list
 * makes the registrable domain wherever one owner holds it: tx.acme.com.br
 * owns acme.com.br and www.acme.com.br, while foo.github.io owns only
 * itself, never github.io's other tenants.
 */
export function messageDestinations(input: {
  html: string | null;
  text: string | null;
  replyTo: readonly string[] | null;
  links?: readonly string[] | undefined;
  verifiedDomains: readonly string[];
  ignore?: ReadonlySet<string> | undefined;
}): string[] {
  const hosts: string[] = [];
  const add = (link: ResolvedLink) => {
    if (link.unresolved) hosts.push(UNRESOLVED_DESTINATION);
    const host = link.url ? new URL(link.url).hostname : "";
    if (LINK_HOST.test(host)) hosts.push(host);
  };
  for (const link of extractLinks(input.html, input.text)) add(link);
  for (const url of input.links ?? []) add(resolveTextUrl(url));
  for (const address of input.replyTo ?? []) {
    const domain = parseSingleSender(address)?.domain;
    if (domain) hosts.push(domain);
  }
  const own = new Set([...input.verifiedDomains.map(ownerDomain), ...(input.ignore ?? [])]);
  return [...new Set(hosts.map(ownerDomain))].filter((d) => d !== "" && !own.has(d)).sort();
}

/**
 * A message's destinations as its team stands with them: `novel`, never
 * cleared, revoked, or a shortener, which a shortener always is; and
 * `probation`, cleared under DESTINATION_PROBATION_DAYS before `now`.
 */
export async function destinationStanding(
  db: Db,
  teamId: string,
  destinations: readonly string[],
  now: Date,
): Promise<{ novel: string[]; probation: string[]; vouched: string[] }> {
  if (destinations.length === 0) return { novel: [], probation: [], vouched: [] };
  const rows = await db
    .select({ domain: td.domain, clearedAt: td.clearedAt, operatorClearedAt: td.operatorClearedAt })
    .from(td)
    .where(and(eq(td.teamId, teamId), inArray(td.domain, [...destinations]), isNull(td.revokedAt)));
  const cleared = new Map(rows.map((row) => [row.domain, row.clearedAt.getTime()]));
  const vouched = new Set(rows.filter((row) => row.operatorClearedAt).map((row) => row.domain));
  const since = now.getTime() - DESTINATION_PROBATION_DAYS * DAY_MS;
  return {
    novel: destinations.filter((d) => isShortener(d) || !cleared.has(d)),
    probation: destinations.filter((d) => !isShortener(d) && (cleared.get(d) ?? 0) > since),
    vouched: destinations.filter((d) => !isShortener(d) && vouched.has(d)),
  };
}

/** The destinations among these the team has not cleared; a shortener never is. */
export async function unclearedDestinations(
  db: Db,
  teamId: string,
  destinations: readonly string[],
): Promise<string[]> {
  return (await destinationStanding(db, teamId, destinations, new Date())).novel;
}

/**
 * Where a message sends its reader, as its team stands with it (see
 * destinationStanding): what is new to it, which the gate judges before SES
 * and the judge lists first, what cleared lately, which is judged after
 * the send, what an operator released mail to, and `all` of it together.
 */
export async function teamDestinationStanding(
  db: Db,
  input: {
    teamId: string;
    html: string | null;
    text: string | null;
    replyTo: readonly string[] | null;
    links?: readonly string[] | undefined;
    ignore?: ReadonlySet<string> | undefined;
    now: Date;
  },
): Promise<{ novel: string[]; probation: string[]; vouched: string[]; all: string[] }> {
  const d = schema.domains;
  const verified = await db
    .select({ name: d.name })
    .from(d)
    .where(and(eq(d.teamId, input.teamId), eq(d.status, "verified")));
  const destinations = messageDestinations({
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    links: input.links,
    ignore: input.ignore,
    verifiedDomains: verified.map((row) => row.name),
  });
  return {
    ...(await destinationStanding(db, input.teamId, destinations, input.now)),
    all: destinations,
  };
}

/** The destinations of a message its team has not cleared (see teamDestinationStanding). */
export async function teamNovelDestinations(
  db: Db,
  input: {
    teamId: string;
    html: string | null;
    text: string | null;
    replyTo: readonly string[] | null;
    links?: readonly string[] | undefined;
    ignore?: ReadonlySet<string> | undefined;
  },
): Promise<string[]> {
  return (await teamDestinationStanding(db, { ...input, now: new Date() })).novel;
}

/**
 * Whether a verdict vouches for the new destinations of the message it
 * judged: under DESTINATION_CLEAR_BELOW, naming no phishing-type category or
 * reason, on a message that carried DESTINATIONS_CLEARED_MAX of them at most.
 */
export function verdictClearsDestinations(
  v: { score: number; categories: readonly string[]; reasons: readonly string[] },
  destinations: number,
): boolean {
  return (
    v.score < DESTINATION_CLEAR_BELOW &&
    destinations <= DESTINATIONS_CLEARED_MAX &&
    !v.categories.some((c) => (MONITOR_HOLD_CATEGORIES as readonly string[]).includes(c)) &&
    !v.reasons.some((r) => (MONITOR_HOLD_REASONS as readonly string[]).includes(r))
  );
}

/**
 * The team cleared these destinations: mail to them no longer waits. A
 * shortener never clears, and a verdict never clears a revoked destination
 * again; an operator's release (`operator`) does.
 */
export async function clearDestinations(
  db: Db,
  teamId: string,
  destinations: readonly string[],
  now: Date = new Date(),
  opts: { operator?: boolean } = {},
): Promise<void> {
  const domains = destinations.filter((d) => !isShortener(d));
  if (domains.length === 0) return;
  const operatorClearedAt = opts.operator ? now : null;
  const rows = db
    .insert(td)
    .values(domains.map((domain) => ({ teamId, domain, clearedAt: now, operatorClearedAt })));
  await (opts.operator
    ? rows.onConflictDoUpdate({
        target: [td.teamId, td.domain],
        set: {
          operatorClearedAt: now,
          revokedAt: null,
          // A revoked name clears afresh; one still cleared keeps its date.
          clearedAt: sql`case when ${td.revokedAt} is null then ${td.clearedAt} else ${now} end`,
        },
      })
    : rows.onConflictDoNothing());
}

/**
 * A spared verdict does to the burst it belongs to what the hold would have:
 * the team's other mail waiting on a phishing-type verdict from
 * `holdRepeatScore`, queued or parked for quota, parks for the review list
 * with it, marked "burst". Mail an operator's clearance vouched for
 * (`spared_hold` "vouched") flows. Releasing a burst row vouches for none
 * of its destinations: only the spared verdict's own were looked at.
 */
export async function spareWaitingSamples(
  db: Db,
  input: { teamId: string; holdRepeatScore: number },
): Promise<number> {
  const rows = await db
    .select({
      id: ms.id,
      score: ms.score,
      verdict: ms.verdict,
      categories: ms.categories,
      reasons: ms.reasons,
    })
    .from(ms)
    .innerJoin(e, eq(e.id, ms.emailId))
    .where(
      and(
        eq(ms.teamId, input.teamId),
        eq(ms.screening, true),
        eq(ms.status, "judged"),
        isNull(ms.sparedHold),
        gte(ms.score, input.holdRepeatScore),
        or(
          eq(e.latestStatus, "queued"),
          and(eq(e.latestStatus, "queued_quota"), isNull(e.parkReason)),
        ),
        isNull(e.sentAt),
        isNull(e.screenReleasedAt),
      ),
    );
  const ids = rows.filter((row) => isHoldVerdict(row, input.holdRepeatScore)).map((row) => row.id);
  if (ids.length > 0) {
    await db.update(ms).set({ sparedHold: "burst" }).where(inArray(ms.id, ids));
  }
  return ids.length;
}

/**
 * Mail to these destinations drew a phishing-type verdict within their
 * probation: they are new again until an operator releases mail to them.
 * The ones revoked now.
 */
export async function revokeDestinations(
  db: Db,
  teamId: string,
  destinations: readonly string[],
  now: Date,
): Promise<string[]> {
  if (destinations.length === 0) return [];
  const rows = await db
    .update(td)
    .set({ revokedAt: now })
    .where(and(eq(td.teamId, teamId), inArray(td.domain, [...destinations]), isNull(td.revokedAt)))
    .returning({ domain: td.domain });
  return rows.map((row) => row.domain);
}

/**
 * Whether a verdict on mail to a new destination parks it for a team past
 * new: a phishing-type one from `holdScore`, or from `holdRepeatScore` when
 * one of its link domains is under YOUNG_DOMAIN_DAYS old or of an age not
 * known yet (`linkYoung` null on such a verdict: see anyYoungLinkDomain).
 * Such a team is never held for it: an agency's every client would stop
 * with it.
 */
export function destinationVerdictParks(
  v: {
    score: number | null;
    verdict: string | null;
    categories: readonly string[] | null;
    reasons: readonly string[] | null;
    linkYoung: boolean | null;
  },
  s: Pick<MonitorSettings, "holdScore" | "holdRepeatScore">,
): boolean {
  return (
    isHoldVerdict(v, s.holdScore) || (v.linkYoung !== false && isHoldVerdict(v, s.holdRepeatScore))
  );
}

const young = (registeredAt: Date | null, at: Date) =>
  registeredAt !== null && at.getTime() - registeredAt.getTime() < YOUNG_DOMAIN_DAYS * DAY_MS;

/** Link-age lookups in flight, by domain: verdicts that ask at once share one. */
const linkAgeLookups = new Map<string, Promise<boolean | null>>();
/** When a domain's lookup last failed: it is not asked again for LINK_AGE_FAILED_TTL_MS. */
const linkAgeFailures = new Map<string, number>();
/** Domains a verdict had no room to look up, looked up one at a time in the background. */
const linkAgeBacklog = new Set<string>();
let linkAgeDraining = false;

/** One lookup, written to the shared cache: whether the domain is young, null when it failed. */
function lookUpLinkAge(
  db: Db,
  resolver: DomainAgeResolver,
  domain: string,
  at: Date,
): Promise<boolean | null> {
  const running = linkAgeLookups.get(domain);
  if (running) return running;
  const lookup = (async () => {
    try {
      const age = await resolver.lookup(domain);
      const row = {
        domain,
        registeredAt: age.registeredAt,
        source: age.source,
        checkedAt: new Date(),
      };
      const la = schema.linkDomainAges;
      await db.insert(la).values(row).onConflictDoUpdate({ target: la.domain, set: row });
      return young(age.registeredAt, at);
    } catch {
      const failedAt = Date.now();
      if (linkAgeFailures.size >= LINK_AGE_BACKLOG_MAX) {
        for (const [d, t] of linkAgeFailures) {
          if (t < failedAt - LINK_AGE_FAILED_TTL_MS) linkAgeFailures.delete(d);
        }
      }
      linkAgeFailures.set(domain, failedAt);
      return null;
    } finally {
      linkAgeLookups.delete(domain);
    }
  })();
  linkAgeLookups.set(domain, lookup);
  return lookup;
}

function queueLinkAges(
  db: Db,
  resolver: DomainAgeResolver,
  domains: readonly string[],
  at: Date,
): void {
  for (const domain of domains) {
    if (linkAgeBacklog.size < LINK_AGE_BACKLOG_MAX) linkAgeBacklog.add(domain);
  }
  if (linkAgeDraining) return;
  linkAgeDraining = true;
  void (async () => {
    try {
      // A Set's iterator visits what is added while it runs.
      for (const domain of linkAgeBacklog) {
        linkAgeBacklog.delete(domain);
        await lookUpLinkAge(db, resolver, domain, at);
      }
    } finally {
      linkAgeDraining = false;
    }
  })();
}

/**
 * Whether any of these link domains was registered under YOUNG_DOMAIN_DAYS
 * before `at`: true as soon as one is known to be, false once every one is
 * known not to be, null while an age is not known (its lookup failed in the
 * last hour, ran past `budgetMs`, or waits in the background beyond the
 * LINK_AGE_LOOKUPS_PER_VERDICT this verdict asks). Ages live in a cache every
 * team shares, and a lookup still running fills it for the next verdict. A
 * free host's names, which no registry dates (only their first
 * certificate), and shorteners are never looked up; an age no source has is
 * not young.
 */
export async function anyYoungLinkDomain(
  db: Db,
  resolver: DomainAgeResolver,
  domains: readonly string[],
  at: Date,
  opts: { budgetMs: number },
): Promise<boolean | null> {
  const la = schema.linkDomainAges;
  const datable = [
    ...new Set(
      domains.filter((d) => !isShortener(d) && registrableDomain(d) === d && ownerDomain(d) === d),
    ),
  ];
  if (datable.length === 0) return false;
  const cached = await db
    .select({ domain: la.domain, registeredAt: la.registeredAt })
    .from(la)
    .where(
      and(
        inArray(la.domain, datable),
        or(
          isNotNull(la.registeredAt),
          gte(la.checkedAt, new Date(at.getTime() - LINK_AGE_UNKNOWN_TTL_MS)),
        ),
      ),
    );
  if (cached.some((row) => young(row.registeredAt, at))) return true;
  const missing = datable.filter((d) => !cached.some((row) => row.domain === d));
  const failedSince = Date.now() - LINK_AGE_FAILED_TTL_MS;
  const askable = missing.filter((d) => (linkAgeFailures.get(d) ?? 0) <= failedSince);
  const asked = askable.slice(0, LINK_AGE_LOOKUPS_PER_VERDICT);
  const later = askable.slice(LINK_AGE_LOOKUPS_PER_VERDICT);
  if (later.length > 0) queueLinkAges(db, resolver, later, at);
  let unknown = askable.length < missing.length || later.length > 0;
  if (asked.length === 0) return unknown ? null : false;
  return new Promise((resolve) => {
    let left = asked.length;
    const timer = setTimeout(() => resolve(null), opts.budgetMs);
    timer.unref?.();
    for (const domain of asked) {
      void lookUpLinkAge(db, resolver, domain, at).then((found) => {
        if (found === true) {
          clearTimeout(timer);
          resolve(true);
          return;
        }
        if (found === null) unknown = true;
        left -= 1;
        if (left === 0) {
          clearTimeout(timer);
          resolve(unknown ? null : false);
        }
      });
    }
  });
}

/**
 * What screening reads of a team, once per send: its monitor tier, and
 * whether it is in its first window, both with the usage history so a quiet
 * old team is not new. An exempt team never has a first window.
 */
export interface ScreeningTeam {
  tier: MonitorTier;
  firstWindow: boolean;
}

export async function screeningTeam(
  db: Db,
  s: MonitorSettings,
  teamId: string,
  now: Date,
): Promise<ScreeningTeam> {
  const state = await loadMonitorState(db, await monitorRowWithHistory(db, teamId, now), now);
  const tier = monitorTier(state, s, now);
  return { tier, firstWindow: tier !== "exempt" && inFirstWindow(state, s, now) };
}

/** A team's monitor tier as screening reads it (see screeningTeam). */
export async function screeningTier(
  db: Db,
  s: MonitorSettings,
  teamId: string,
  now: Date,
): Promise<MonitorTier> {
  return (await screeningTeam(db, s, teamId, now)).tier;
}

/**
 * Whether the team's sending domain reads as young at `at`: registered
 * under YOUNG_DOMAIN_DAYS before it, or of unknown age (no source had a
 * date, or the lookup has not answered yet). Shared-domain mail always
 * does: that domain is every team's, so its age vouches for none of them.
 * Null when the team has no such domain row.
 */
export async function sendingDomainYoung(
  db: Db,
  input: {
    teamId: string;
    domainId?: string | null;
    name?: string | null;
    shared?: boolean | undefined;
  },
  at: Date,
): Promise<boolean | null> {
  if (input.shared) return true;
  const d = schema.domains;
  const match = input.domainId
    ? eq(d.id, input.domainId)
    : input.name
      ? eq(d.name, input.name.toLowerCase())
      : null;
  if (!match) return null;
  const [row] = await db
    .select({ registeredAt: d.registeredAt })
    .from(d)
    .where(and(eq(d.teamId, input.teamId), match))
    .limit(1);
  if (!row) return null;
  return (
    row.registeredAt === null ||
    at.getTime() - row.registeredAt.getTime() < YOUNG_DOMAIN_DAYS * DAY_MS
  );
}

type ScreenedEmail = Pick<
  typeof schema.emails.$inferSelect,
  | "id"
  | "teamId"
  | "domainId"
  | "broadcastId"
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "replyTo"
  | "inboxId"
  | "threadId"
  | "screenReleasedAt"
>;

/**
 * Whether shared-domain mail is cold: a recipient never wrote to its inbox
 * (no first_in_at) and is neither a member's login nor a sender its thread
 * vouches for: the owner and thread classes of classifyRecipients, the only
 * recipients a reply-only inbox may write to. Mail of an inbox deleted
 * since knows no one.
 */
async function coldSharedSend(
  db: Db,
  email: Pick<ScreenedEmail, "teamId" | "inboxId" | "threadId" | "to" | "cc" | "bcc">,
): Promise<boolean> {
  const recipients = [
    ...new Set([...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])].map(addressKey)),
  ];
  const { inboxId, threadId } = email;
  const c = schema.inboxCorrespondents;
  const [members, senders, wroteIn] = await Promise.all([
    teamMemberEmails(db, email.teamId),
    inboxId && threadId
      ? threadSenders(db, { inboxId, threadId, shared: true })
      : new Set<string>(),
    inboxId
      ? db
          .select({ address: c.address })
          .from(c)
          .where(
            and(eq(c.inboxId, inboxId), inArray(c.address, recipients), isNotNull(c.firstInAt)),
          )
      : [],
  ]);
  const known = new Set([...members, ...senders, ...wroteIn.map((row) => row.address)]);
  return recipients.some((address) => !known.has(address));
}

/** What screening reads of one email before SES. */
export interface ScreeningRead {
  /** Why it is judged before SES; empty when it is not. */
  reasons: ScreenReason[];
  /** Its destinations the team has not cleared. */
  novel: string[];
  /** It carries a destination cleared within its probation: judged after the send, always. */
  probation: boolean;
}

/**
 * Why this email is judged before SES. Every reason is decided here, so one
 * more is one more branch. A broadcast's own HTML and its first copy are
 * screened at its fan-out: a copy here only for the destinations its
 * contact fields put in it, which the HTML does not carry. Links read from
 * files count as destinations at every tier; files and an opaque body
 * screen a transactional email while its team is new; cold shared-domain
 * mail is screened at every tier.
 */
export async function screeningReasons(
  db: Db,
  input: {
    email: Pick<
      ScreenedEmail,
      "teamId" | "broadcastId" | "replyTo" | "inboxId" | "threadId" | "to" | "cc" | "bcc"
    >;
    /** Sent from the shared inbox domain. */
    shared?: boolean | undefined;
    /** The decrypted body; without it no destination is read. */
    body: { html: string | null; text: string | null } | null;
    media?: SendMedia | undefined;
    /** The platform's own hosts, which are nobody's destination. */
    ignore?: ReadonlySet<string> | undefined;
    team: ScreeningTeam;
    now: Date;
  },
): Promise<ScreeningRead> {
  const { email, team, now } = input;
  const read: ScreeningRead = { reasons: [], novel: [], probation: false };
  if (team.tier === "exempt") return read;
  if (email.broadcastId === null) {
    if (team.firstWindow) read.reasons.push("first_window");
    const { media } = input;
    if (media && (media.attachments > 0 || media.opaque) && team.tier === "new") {
      read.reasons.push("media");
    }
    if (input.shared && (await coldSharedSend(db, email))) read.reasons.push("recipient");
  }
  if (input.body) {
    const standing = await teamDestinationStanding(db, {
      teamId: email.teamId,
      html: input.body.html,
      text: input.body.text,
      replyTo: email.replyTo,
      links: input.media?.links,
      ignore: input.ignore,
      now,
    });
    read.novel = standing.novel;
    // A broadcast's own HTML is judged at its fan-out, its probation too.
    read.probation = email.broadcastId === null && standing.probation.length > 0;
    // ponytail: two small reads per copy of a broadcast that links off the
    // team's domains; cache the broadcast's own destinations per process if
    // large fan-outs make them show.
    if (read.novel.length > 0 && email.broadcastId) {
      const [broadcast] = await db
        .select({
          html: schema.broadcasts.html,
          text: schema.broadcasts.text,
          replyTo: schema.broadcasts.replyTo,
        })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, email.broadcastId));
      const own = new Set(
        broadcast
          ? messageDestinations({
              html: broadcast.html,
              text: broadcast.text,
              replyTo: broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null,
              verifiedDomains: [],
              ignore: input.ignore,
            })
          : [],
      );
      read.novel = read.novel.filter((d) => !own.has(d));
    }
    if (read.novel.length > 0) read.reasons.push("destination");
  }
  return read;
}

/**
 * A screening sample without a verdict: wait for it ("wait", the judge
 * re-queues what waits on it), re-run a failed judge for a young or
 * unknown-age sending domain (sendingDomainYoung: shared-domain mail is
 * one), give up on it ("park") once the re-runs are spent, or go on
 * unscreened ("proceed") for an older domain. Null once the sample is
 * judged.
 */
async function unanswered(
  db: Db,
  deps: MonitorDeps,
  sample: Sample,
  input: { domainId: string | null; shared?: boolean | undefined; now: Date },
): Promise<"wait" | "park" | "proceed" | null> {
  const { now } = input;
  if (sample.status === "judged") return null;
  if (sample.status === "pending") {
    if (now.getTime() - sample.createdAt.getTime() > SCREEN_STALE_MS) {
      await deps.enqueueJudge(sample.id, { teamId: sample.teamId, screening: true });
    }
    return "wait";
  }
  const young = await sendingDomainYoung(
    db,
    { teamId: sample.teamId, domainId: input.domainId, shared: input.shared },
    now,
  );
  if (!young) return "proceed";
  if (sample.screenRetries >= SCREEN_RETRIES) return "park";
  const [rearmed] = await db
    .update(ms)
    .set({
      status: "pending",
      errorClass: null,
      judgedAt: null,
      latencyMs: null,
      attempts: 0,
      screenRetries: sample.screenRetries + 1,
    })
    .where(and(eq(ms.id, sample.id), eq(ms.status, "unjudged")))
    .returning({ id: ms.id });
  if (rearmed) {
    await deps.enqueueJudge(sample.id, {
      teamId: sample.teamId,
      screening: true,
      startAfter: new Date(now.getTime() + SCREEN_RETRY_MS),
    });
  }
  return "wait";
}

/** Whether an answered screening sample's media parks what waits on it (mediaParks). */
function mediaParksSample(sample: Sample, tier: MonitorTier): boolean {
  return sample.status !== "pending" && mediaParks(sample.mediaIssues, tier);
}

export type ScreenDecision =
  /**
   * Send now. `sample` is the email's screening sample when it has one: no
   * second sample is drawn after the send, and one the judge never answered
   * is judged then (`unjudged`), as unscreened mail is. `probation`: it
   * carries a destination cleared within its probation, so the send is
   * always judged afterwards.
   */
  | {
      action: "send";
      sample: { id: string; unjudged: boolean } | null;
      probation?: boolean | undefined;
    }
  /** Wait: run the send again at `until`, or when the judge re-queues it (null). */
  | { action: "wait"; until: Date | null }
  /**
   * It waits for an operator: the judge kept failing on a young domain's
   * email ("screening"), read a team past new's mail to a new destination as
   * phishing, or it carries more new destinations than a verdict can vouch
   * for ("destination"), its images or files were not cleared ("media",
   * see mediaParks; a new team's flagged file parks on the send path's own
   * read, before any verdict), or the judge read cold shared-domain mail as
   * phishing ("recipient").
   */
  | { action: "park"; reason: ScreenParkReason };

const SEND_UNSCREENED: ScreenDecision = { action: "send", sample: null };

/**
 * Starts screening an email that has a reason and no sample: more new
 * destinations than NOVEL_DESTINATIONS_MAX park for an operator unjudged; a
 * team with SCREEN_OUTSTANDING_MAX samples already waiting on the judge
 * waits its turn; one past its DESTINATION_SCREENS_PER_DAY waits for the
 * next UTC day when a new destination is the only reason. None of these
 * ever sends the email unscreened.
 */
async function startScreening(
  db: Db,
  deps: MonitorDeps,
  s: MonitorSettings,
  input: {
    email: { id: string; teamId: string; broadcastId: string | null };
    read: ScreeningRead;
    unsafe: boolean;
    now: Date;
  },
): Promise<ScreenDecision> {
  const { email, read, now } = input;
  if (read.novel.length > NOVEL_DESTINATIONS_MAX) return { action: "park", reason: "destination" };
  const unsafe = read.reasons.includes("media") && input.unsafe;
  const [outstanding] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ms)
    .where(and(eq(ms.teamId, email.teamId), eq(ms.status, "pending"), eq(ms.screening, true)));
  const full = (outstanding?.n ?? 0) >= SCREEN_OUTSTANDING_MAX;
  if (full && !unsafe) return { action: "wait", until: new Date(now.getTime() + SCREEN_RETRY_MS) };
  let destination = read.reasons.includes("destination");
  if (destination && !full) {
    const [screened] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(ms)
      .where(
        and(
          eq(ms.teamId, email.teamId),
          gte(ms.createdAt, new Date(`${utcDay(now)}T00:00:00Z`)),
          eq(ms.screening, true),
          inArray(ms.kind, ["destination", "broadcast_copy"]),
        ),
      );
    if ((screened?.n ?? 0) >= DESTINATION_SCREENS_PER_DAY) {
      // Another reason screens it anyway, as that reason's sample.
      if (read.reasons.length === 1 && !unsafe) {
        return { action: "wait", until: nextUtcDayStart(now) };
      }
      destination = false;
    }
  }
  if (!full) {
    await recordMonitorSample(db, deps, s, {
      teamId: email.teamId,
      emailId: email.id,
      broadcastId: email.broadcastId,
      kind: email.broadcastId
        ? "broadcast_copy"
        : destination
          ? "destination"
          : read.reasons.includes("first_window")
            ? "first_sends"
            : "anomaly",
      now,
      screening: true,
    });
  }
  // The file waits for a person whatever the verdict; the judge still reads
  // it, for the hold and for the review list, when it has room.
  if (unsafe) return { action: "park", reason: "media" };
  return { action: "wait", until: null };
}

/**
 * The gate in front of SES for one queued customer email, on when the
 * judge (`deps`) and the auto-hold are. An email with a screening reason
 * and no verdict waits for one (startScreening); a phishing-type verdict
 * that held nothing waits SCREEN_HOLD_WAIT_MS more while its team is new
 * (first-window mail, broadcast copies, and mail whose new link domain's age
 * is not known), in case the burst it belongs to holds the team; mail to a
 * new destination of a team past new parks on a verdict that
 * destinationVerdictParks, and cold shared-domain mail of any team not
 * exempt on a phishing-type verdict from `holdRepeatScore`; a judge that
 * keeps failing parks a young domain's email, shared-domain mail included,
 * and lets an older one's through; media the judge could not clear parks
 * as mediaParks says. The team's own standing (a hold, a pause) is the
 * caller's to read first, on every pass; `team` is what it already read of
 * the team this pass.
 */
export async function screenBeforeSend(
  db: Db,
  deps: MonitorDeps,
  input: {
    email: ScreenedEmail;
    body: { html: string | null; text: string | null };
    media?: SendMedia | undefined;
    ignore?: ReadonlySet<string> | undefined;
    team?: ScreeningTeam | undefined;
    /** SHARED_INBOX_DOMAIN; the environment's when absent. */
    sharedInboxDomain?: string | null | undefined;
    now: Date;
  },
): Promise<ScreenDecision> {
  const { email, now } = input;
  // The settings reader throws only before its first read; the monitor's own
  // draw degrades to off the same way.
  const s = await deps.settings().catch(() => null);
  if (!s?.autoHold) return SEND_UNSCREENED;
  const shared = isSharedInboxSender(
    email.from,
    input.sharedInboxDomain === undefined ? sharedInboxDomain() : input.sharedInboxDomain,
  );
  const [sample] = await db
    .select()
    .from(ms)
    .where(eq(ms.emailId, email.id))
    .orderBy(desc(ms.createdAt))
    .limit(1);
  if (email.screenReleasedAt) {
    return {
      action: "send",
      sample: sample?.screening ? { id: sample.id, unjudged: sample.status !== "judged" } : null,
    };
  }
  const team = input.team ?? (await screeningTeam(db, s, email.teamId, now));
  if (!sample?.screening) {
    const read = await screeningReasons(db, { ...input, team, shared });
    if (read.reasons.length === 0) {
      return { action: "send", sample: null, probation: read.probation };
    }
    if (!sample) {
      return startScreening(db, deps, s, {
        email,
        read,
        unsafe: input.media?.unsafe === true,
        now,
      });
    }
    // A rendered copy drawn at fan-out: the email now waits on its verdict.
    await db.update(ms).set({ screening: true }).where(eq(ms.id, sample.id));
    sample.screening = true;
    if (sample.status === "pending") {
      await deps.enqueueJudge(sample.id, { teamId: email.teamId, screening: true });
      return { action: "wait", until: null };
    }
  }
  const screened = { id: sample.id, unjudged: false };
  // Media that parks whatever the verdict parks now, a judge outage or not.
  if (mediaParksSample(sample, team.tier)) return { action: "park", reason: "media" };
  const waiting = await unanswered(db, deps, sample, { domainId: email.domainId, shared, now });
  if (waiting === "wait") return { action: "wait", until: null };
  if (waiting === "park") return { action: "park", reason: "screening" };
  if (waiting === "proceed") return { action: "send", sample: { id: sample.id, unjudged: true } };
  // The hold this verdict met spared the team for a platform link: the mail waits for a person instead.
  if (sample.sparedHold && sample.sparedHold !== "vouched") {
    return { action: "park", reason: "destination" };
  }
  if (!isHoldVerdict(sample, s.holdRepeatScore)) return { action: "send", sample: screened };
  const destinations = sample.destinations?.length ?? 0;
  if (destinations > 0 && destinationVerdictParks(sample, s) && team.tier !== "new") {
    return { action: "park", reason: "destination" };
  }
  if (shared && team.tier !== "exempt" && (await coldSharedSend(db, email))) {
    return { action: "park", reason: "recipient" };
  }
  // An operator cleared every platform name the verdict rests on: nothing to wait for.
  if (sample.sparedHold === "vouched") return { action: "send", sample: screened };
  const waits = email.broadcastId
    ? team.tier === "new"
    : team.firstWindow || (team.tier === "new" && destinations > 0 && sample.linkYoung === null);
  if (sample.judgedAt && waits) {
    const until = new Date(sample.judgedAt.getTime() + SCREEN_HOLD_WAIT_MS);
    if (now < until) return { action: "wait", until };
  }
  return { action: "send", sample: screened };
}

/**
 * Where a screened fan-out stands on its broadcast's own HTML: wait for the
 * verdict (the judge re-queues the fan-out), go, or park every copy for an
 * operator: once the judge kept failing on a young sending domain, when a
 * team past new's HTML sends readers to a new destination read as
 * phishing, or when its images were not cleared (mediaParks). A verdict that
 * pauses or holds the team is read by the fan-out's own checks.
 */
export async function broadcastScreen(
  db: Db,
  deps: MonitorDeps,
  input: { skeletonSampleId: string; domainId: string; now: Date },
): Promise<{ action: "wait" } | { action: "go" } | { action: "park"; reason: ScreenParkReason }> {
  const [sample] = await db.select().from(ms).where(eq(ms.id, input.skeletonSampleId));
  if (!sample?.screening) return { action: "go" };
  const s = await deps.settings();
  const tier = await screeningTier(db, s, sample.teamId, input.now);
  if (mediaParksSample(sample, tier)) return { action: "park", reason: "media" };
  const waiting = await unanswered(db, deps, sample, input);
  if (waiting === "wait") return { action: "wait" };
  if (waiting === "park") return { action: "park", reason: "screening" };
  if (
    waiting === null &&
    sample.destinations?.length &&
    destinationVerdictParks(sample, s) &&
    tier !== "new"
  ) {
    return { action: "park", reason: "destination" };
  }
  return { action: "go" };
}

/**
 * A screened email that went out without a verdict, its sample unanswered
 * or still waiting on the judge, is judged afterwards, as unscreened mail is.
 */
export async function judgeAfterSend(
  db: Db,
  deps: MonitorDeps,
  sample: { id: string; teamId: string },
): Promise<void> {
  const [rearmed] = await db
    .update(ms)
    .set({ status: "pending", screening: false, errorClass: null, judgedAt: null, attempts: 0 })
    .where(and(eq(ms.id, sample.id), inArray(ms.status, ["pending", "unjudged"])))
    .returning({ id: ms.id });
  if (rearmed) await deps.enqueueJudge(rearmed.id, { teamId: sample.teamId, screening: false });
}

/** Rows parked for an operator, or for a hold the operator decides on. */
const parkedForReview = (): SQL | undefined =>
  and(
    eq(e.latestStatus, "queued_quota"),
    isNull(e.sentAt),
    inArray(e.parkReason, ["review", ...OPERATOR_PARK_REASONS]),
  );

/**
 * Which of the team's waiting emails an operator acts on: the ones named, or
 * every one parked by `parkedBefore` (the moment they were shown the list),
 * so mail parked after they looked is never released unseen; all of them
 * when neither is given.
 */
interface Selection {
  teamId: string;
  emailIds?: readonly string[] | undefined;
  parkedBefore?: Date | undefined;
}

function scope(input: Selection): SQL | undefined {
  return and(
    eq(e.teamId, input.teamId),
    input.emailIds ? inArray(e.id, [...input.emailIds]) : undefined,
    input.parkedBefore ? or(isNull(e.parkedAt), lte(e.parkedAt, input.parkedBefore)) : undefined,
  );
}

/**
 * Queued emails of the team waiting out the short wait a phishing-type
 * verdict from `holdLine` brings, not released from it yet.
 */
async function waitingOnVerdict(
  db: Db,
  input: Selection & { holdLine: number },
): Promise<string[]> {
  const rows = await db
    .select({
      id: e.id,
      score: ms.score,
      verdict: ms.verdict,
      categories: ms.categories,
      reasons: ms.reasons,
    })
    .from(e)
    .innerJoin(ms, and(eq(ms.emailId, e.id), eq(ms.screening, true)))
    .where(
      and(
        eq(e.teamId, input.teamId),
        input.emailIds ? inArray(e.id, [...input.emailIds]) : undefined,
        input.parkedBefore ? lte(ms.judgedAt, input.parkedBefore) : undefined,
        eq(e.latestStatus, "queued"),
        isNull(e.sentAt),
        isNull(e.screenReleasedAt),
        eq(ms.status, "judged"),
      ),
    );
  return rows.filter((row) => isHoldVerdict(row, input.holdLine)).map((row) => row.id);
}

/**
 * The review list's Release: these emails of the team are sent without
 * being screened again. Parked rows lose their park reason, so quota.drain
 * releases them, charging the plan and the warm-up as for any parked row;
 * rows waiting out a verdict are returned for the caller to queue now. Mail
 * a review hold parks is released with the hold, never here. Releasing mail
 * a new destination parked, or a verdict's short wait, clears the
 * destinations it carries; a park for media or a failing judge vouches for
 * none.
 */
export async function releaseWaitingEmails(
  db: Db,
  input: Selection & { holdLine: number; now?: Date },
): Promise<{ parked: number; queued: string[] }> {
  const now = input.now ?? new Date();
  const operatorParked = and(
    eq(e.latestStatus, "queued_quota"),
    isNull(e.sentAt),
    inArray(e.parkReason, [...OPERATOR_PARK_REASONS]),
  );
  const candidates = await db
    .select({ id: e.id, parkReason: e.parkReason })
    .from(e)
    .where(and(scope(input), operatorParked));
  const parked =
    candidates.length === 0
      ? []
      : await db
          .update(e)
          .set({ parkReason: null, screenReleasedAt: now })
          .where(
            and(
              inArray(
                e.id,
                candidates.map((row) => row.id),
              ),
              operatorParked,
            ),
          )
          .returning({ id: e.id });
  const waiting = await waitingOnVerdict(db, input);
  const queued =
    waiting.length === 0
      ? []
      : await db
          .update(e)
          .set({ screenReleasedAt: now })
          .where(and(inArray(e.id, waiting), eq(e.latestStatus, "queued"), isNull(e.sentAt)))
          .returning({ id: e.id });
  const released = new Set(parked.map((row) => row.id));
  const vouched = [
    ...candidates
      .filter((row) => row.parkReason === "destination" && released.has(row.id))
      .map((row) => row.id),
    ...queued.map((row) => row.id),
  ];
  if (vouched.length > 0) {
    // A burst row parked beside a spared verdict was never looked at for its own names.
    const samples = await db
      .select({ destinations: ms.destinations, sparedHold: ms.sparedHold })
      .from(ms)
      .where(and(inArray(ms.emailId, vouched), eq(ms.screening, true)));
    await clearDestinations(
      db,
      input.teamId,
      [
        ...new Set(
          samples
            .filter((row) => row.sparedHold !== "burst")
            .flatMap((row) => row.destinations ?? []),
        ),
      ],
      now,
      { operator: true },
    );
  }
  return { parked: parked.length, queued: queued.map((row) => row.id) };
}

/**
 * The review list's Cancel: these emails of the team never go out. A queued
 * row hands back the reservation it held; a parked one held none.
 */
export async function cancelWaitingEmails(
  db: Db,
  input: Selection & { holdLine: number },
): Promise<number> {
  const waiting = await waitingOnVerdict(db, input);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows = await t
      .update(e)
      .set({ latestStatus: "canceled" })
      .where(
        or(
          and(scope(input), parkedForReview()),
          waiting.length === 0
            ? undefined
            : and(inArray(e.id, waiting), eq(e.latestStatus, "queued"), isNull(e.sentAt)),
        ),
      )
      .returning({ to: e.to, cc: e.cc, bcc: e.bcc, parkReason: e.parkReason });
    const units = rows
      .filter((row) => row.parkReason === null)
      .reduce((n, row) => n + countDistinctRecipients(row.to, row.cc, row.bcc), 0);
    if (units > 0) {
      const quota = await fetchTeamQuota(t, input.teamId, true);
      if (quota) await releaseQuota(t, { teamId: input.teamId, count: units, quota });
    }
    return rows.length;
  });
}
