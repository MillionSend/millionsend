import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import {
  inFirstWindow,
  isHoldVerdict,
  loadMonitorState,
  type MonitorDeps,
  type MonitorTier,
  monitorRowWithHistory,
  monitorTier,
  recordMonitorSample,
  YOUNG_DOMAIN_DAYS,
} from "./abuse-monitor.js";
import { countDistinctRecipients } from "./accept-email.js";
import type { DomainAgeResolver } from "./domain-age.js";
import { extractAnchors, SHORTENER_HOSTS } from "./email-insights.js";
import { unescapeHtml } from "./html.js";
import type { MonitorSettings } from "./monitor-settings.js";
import { ownerDomain, registrableDomain } from "./org-domain.js";
import { releaseQuota } from "./quota.js";
import { parseSingleSender } from "./sender-address.js";
import { fetchTeamQuota } from "./team-plan.js";
import { unwrapRedirect } from "./url.js";
import { DAY_MS } from "./utc-day.js";

/**
 * Screening before SES: which mail waits for the judge's verdict before it
 * is sent, and what it does while it waits. The send handler asks on every
 * pass; the judge re-queues the send once the verdict lands, and the hold,
 * the pause and the parks the verdict brings are read on the next pass.
 */

/**
 * Why an email is judged before SES: its team is in its first window, or it
 * carries a destination its team has not cleared.
 */
export type ScreenReason = "first_window" | "destination";

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

/** Park reasons the drain never releases: only an operator does, from the review list. */
export const OPERATOR_PARK_REASONS = ["screening", "destination", "media"] as const;

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

const TEXT_URL = /\bhttps?:\/\/[^\s<>"'()]+/gi;
// What a link can resolve to: a DNS name (URL hands IDNs over in punycode),
// or an address. A merge field still in a template is neither.
const LINK_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;

/**
 * Where a message sends its reader: the owner domain (ownerDomain, so a free
 * host's x.pages.dev is its own) of every http(s) link in the HTML's anchors
 * and the text part, a known redirect wrapper read through to its target as
 * the judge reads it, and of each Reply-To address; less the team's verified
 * domains and `ignore` (the platform's own hosts: unsubscribe and tracking
 * links). Each once, sorted.
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
  verifiedDomains: readonly string[];
  ignore?: ReadonlySet<string> | undefined;
}): string[] {
  const hosts: string[] = [];
  const link = (href: string) => {
    const url = unwrapRedirect(href);
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const host = new URL(url).hostname;
      if (LINK_HOST.test(host)) hosts.push(host);
    } catch {
      // Not a URL a mail client could open either.
    }
  };
  for (const anchor of input.html ? extractAnchors(input.html) : []) {
    link(unescapeHtml(anchor.href).trim());
  }
  for (const match of (input.text ?? "").matchAll(TEXT_URL)) link(match[0]);
  for (const address of input.replyTo ?? []) {
    const domain = parseSingleSender(address)?.domain;
    if (domain) hosts.push(domain);
  }
  const own = new Set([...input.verifiedDomains.map(ownerDomain), ...(input.ignore ?? [])]);
  return [...new Set(hosts.map(ownerDomain))].filter((d) => d !== "" && !own.has(d)).sort();
}

/** The destinations among these the team has not cleared; a shortener never is. */
export async function unclearedDestinations(
  db: Db,
  teamId: string,
  destinations: readonly string[],
): Promise<string[]> {
  if (destinations.length === 0) return [];
  const cleared = await db
    .select({ domain: td.domain })
    .from(td)
    .where(and(eq(td.teamId, teamId), inArray(td.domain, [...destinations])));
  const known = new Set(cleared.map((row) => row.domain));
  return destinations.filter((d) => isShortener(d) || !known.has(d));
}

/**
 * The destinations of a message its team has not cleared: what is new to
 * it, which the gate judges before SES and the judge lists first.
 */
export async function teamNovelDestinations(
  db: Db,
  input: {
    teamId: string;
    html: string | null;
    text: string | null;
    replyTo: readonly string[] | null;
    ignore?: ReadonlySet<string> | undefined;
  },
): Promise<string[]> {
  const d = schema.domains;
  const verified = await db
    .select({ name: d.name })
    .from(d)
    .where(and(eq(d.teamId, input.teamId), eq(d.status, "verified")));
  const destinations = messageDestinations({
    ...input,
    verifiedDomains: verified.map((row) => row.name),
  });
  return unclearedDestinations(db, input.teamId, destinations);
}

/** The team cleared these destinations: mail to them no longer waits. A shortener never clears. */
export async function clearDestinations(
  db: Db,
  teamId: string,
  destinations: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const domains = destinations.filter((d) => !isShortener(d));
  if (domains.length === 0) return;
  await db
    .insert(td)
    .values(domains.map((domain) => ({ teamId, domain, clearedAt: now })))
    .onConflictDoNothing();
}

/**
 * Whether a verdict on mail to a new destination parks it for a team past
 * new: a phishing-type one from `holdScore`, or from `holdRepeatScore` when
 * one of its link domains is under YOUNG_DOMAIN_DAYS old. Such a team is
 * never held for it: an agency's every client would stop with it.
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
    isHoldVerdict(v, s.holdScore) || (v.linkYoung === true && isHoldVerdict(v, s.holdRepeatScore))
  );
}

/**
 * Whether any of these link domains was registered under YOUNG_DOMAIN_DAYS
 * before `at`, by a cache every team shares; what it lacks is looked up,
 * waiting at most `budgetMs`, and a lookup still running then fills the
 * cache for the next verdict. An unknown age is not young, and a free
 * host's names, which no registry dates (only their first certificate),
 * and shorteners are never looked up.
 */
export async function anyYoungLinkDomain(
  db: Db,
  resolver: DomainAgeResolver,
  domains: readonly string[],
  at: Date,
  opts: { budgetMs: number },
): Promise<boolean> {
  const la = schema.linkDomainAges;
  const datable = domains.filter(
    (d) => !isShortener(d) && registrableDomain(d) === d && ownerDomain(d) === d,
  );
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
  const young = (registeredAt: Date | null) =>
    registeredAt !== null && at.getTime() - registeredAt.getTime() < YOUNG_DOMAIN_DAYS * DAY_MS;
  if (cached.some((row) => young(row.registeredAt))) return true;
  const missing = datable.filter((d) => !cached.some((row) => row.domain === d));
  if (missing.length === 0) return false;
  const lookups = missing.map(async (domain) => {
    try {
      const age = await resolver.lookup(domain);
      const row = {
        domain,
        registeredAt: age.registeredAt,
        source: age.source,
        checkedAt: new Date(),
      };
      await db.insert(la).values(row).onConflictDoUpdate({ target: la.domain, set: row });
      return young(age.registeredAt);
    } catch {
      // A registry that failed is asked again by the next verdict.
      return false;
    }
  });
  const answered = Promise.all(lookups).then((found) => found.some(Boolean));
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), opts.budgetMs).unref?.();
  });
  return Promise.race([answered, timeout]);
}

/** A team's monitor tier as screening reads it: with the usage history, so a quiet old team is not new. */
async function tierOf(db: Db, s: MonitorSettings, teamId: string, now: Date): Promise<MonitorTier> {
  const row = await monitorRowWithHistory(db, teamId, now);
  return monitorTier(await loadMonitorState(db, row, now), s, now);
}

/**
 * Whether the team's sending domain reads as young at `at`: registered
 * under YOUNG_DOMAIN_DAYS before it, or of unknown age (no source had a
 * date, or the lookup has not answered yet). Null when the team has no
 * such domain row.
 */
export async function sendingDomainYoung(
  db: Db,
  input: { teamId: string; domainId?: string | null; name?: string | null },
  at: Date,
): Promise<boolean | null> {
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

/**
 * Why this email is judged before SES; empty when it is not. Every reason
 * is decided here, so one more is one more branch. A broadcast's own HTML
 * and its first copy are screened at its fan-out: a copy here only for the
 * destinations its contact fields put in it, which the HTML does not carry.
 */
export async function screeningReasons(
  db: Db,
  s: MonitorSettings,
  input: {
    email: { teamId: string; broadcastId: string | null; replyTo: readonly string[] | null };
    /** The decrypted body; without it no destination is read. */
    body: { html: string | null; text: string | null } | null;
    /** The platform's own hosts, which are nobody's destination. */
    ignore?: ReadonlySet<string> | undefined;
    now: Date;
  },
): Promise<ScreenReason[]> {
  const { email, now } = input;
  const reasons: ScreenReason[] = [];
  const [team] = await db
    .select({ plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, email.teamId));
  if (team?.plan === "system") return reasons;
  if (email.broadcastId === null) {
    const row = await monitorRowWithHistory(db, email.teamId, now);
    if (inFirstWindow(await loadMonitorState(db, row, now), s, now)) reasons.push("first_window");
  }
  if (input.body) {
    let novel = await teamNovelDestinations(db, {
      teamId: email.teamId,
      html: input.body.html,
      text: input.body.text,
      replyTo: email.replyTo,
      ignore: input.ignore,
    });
    // ponytail: two small reads per copy of a broadcast that links off the
    // team's domains; cache the broadcast's own destinations per process if
    // large fan-outs make them show.
    if (novel.length > 0 && email.broadcastId) {
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
      novel = novel.filter((d) => !own.has(d));
    }
    if (novel.length > 0) reasons.push("destination");
  }
  return reasons;
}

/**
 * A screening sample without a verdict: wait for it ("wait", the judge
 * re-queues what waits on it), re-run a failed judge for a young or
 * unknown-age sending domain, give up on it ("park") once the re-runs are
 * spent, or go on unscreened ("proceed") for an older domain. Null once the
 * sample is judged.
 */
async function unanswered(
  db: Db,
  deps: MonitorDeps,
  sample: Sample,
  input: { domainId: string | null; now: Date },
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
    { teamId: sample.teamId, domainId: input.domainId },
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

export type ScreenDecision =
  /**
   * Send now. `sample` is the email's screening sample when it has one: no
   * second sample is drawn after the send, and one the judge never answered
   * is judged then (`unjudged`), as unscreened mail is.
   */
  | { action: "send"; sample: { id: string; unjudged: boolean } | null }
  /** Wait: run the send again at `until`, or when the judge re-queues it (null). */
  | { action: "wait"; until: Date | null }
  /**
   * It waits for an operator: the judge kept failing on a young domain's
   * email ("screening"), or read a team past new's mail to a new destination
   * as phishing ("destination").
   */
  | { action: "park"; reason: "screening" | "destination" };

const SEND_UNSCREENED: ScreenDecision = { action: "send", sample: null };

/**
 * The gate in front of SES for one queued customer email, on when the
 * judge (`deps`) and the auto-hold are. An email with a screening reason
 * and no verdict waits for one; a phishing-type verdict that held nothing
 * waits SCREEN_HOLD_WAIT_MS more in the team's first window, in case the
 * burst it belongs to holds the team; mail to a new destination of a team
 * past new parks on a verdict that destinationVerdictParks; a judge that
 * keeps failing parks a young domain's email and lets an older one's
 * through. The team's own standing (a hold, a pause) is the caller's to
 * read first, on every pass.
 */
export async function screenBeforeSend(
  db: Db,
  deps: MonitorDeps,
  input: {
    email: {
      id: string;
      teamId: string;
      domainId: string | null;
      broadcastId: string | null;
      replyTo: string[] | null;
      screenReleasedAt: Date | null;
    };
    body: { html: string | null; text: string | null };
    ignore?: ReadonlySet<string> | undefined;
    now: Date;
  },
): Promise<ScreenDecision> {
  const { email, now } = input;
  // The settings reader throws only before its first read; the monitor's own
  // draw degrades to off the same way.
  const s = await deps.settings().catch(() => null);
  if (!s?.autoHold) return SEND_UNSCREENED;
  const [sample] = await db
    .select()
    .from(ms)
    .where(eq(ms.emailId, email.id))
    .orderBy(desc(ms.createdAt))
    .limit(1);
  if (email.screenReleasedAt) {
    return {
      action: "send",
      sample: sample?.screening ? { id: sample.id, unjudged: false } : null,
    };
  }
  if (!sample?.screening) {
    const reasons = await screeningReasons(db, s, input);
    if (reasons.length === 0) return SEND_UNSCREENED;
    if (sample) {
      // A rendered copy drawn at fan-out: the email now waits on its verdict.
      await db.update(ms).set({ screening: true }).where(eq(ms.id, sample.id));
      sample.screening = true;
      if (sample.status === "pending") {
        await deps.enqueueJudge(sample.id, { teamId: email.teamId, screening: true });
        return { action: "wait", until: null };
      }
    } else {
      const novelty = reasons.includes("destination");
      const id = await recordMonitorSample(db, deps, s, {
        teamId: email.teamId,
        emailId: email.id,
        broadcastId: email.broadcastId,
        kind: novelty ? "destination" : "first_sends",
        now,
        screening: true,
        novelty,
      });
      // Past the team's daily cap the email goes unscreened, as the draw would.
      return id ? { action: "wait", until: null } : SEND_UNSCREENED;
    }
  }
  const screened = { id: sample.id, unjudged: false };
  const waiting = await unanswered(db, deps, sample, { domainId: email.domainId, now });
  if (waiting === "wait") return { action: "wait", until: null };
  if (waiting === "park") return { action: "park", reason: "screening" };
  if (waiting === "proceed") return { action: "send", sample: { id: sample.id, unjudged: true } };
  if (!isHoldVerdict(sample, s.holdRepeatScore)) return { action: "send", sample: screened };
  if (sample.destinations?.length && destinationVerdictParks(sample, s)) {
    const tier = await tierOf(db, s, email.teamId, now);
    if (tier !== "new") return { action: "park", reason: "destination" };
  }
  if (
    sample.judgedAt &&
    (await screeningReasons(db, s, { email, body: null, now })).includes("first_window")
  ) {
    const until = new Date(sample.judgedAt.getTime() + SCREEN_HOLD_WAIT_MS);
    if (now < until) return { action: "wait", until };
  }
  return { action: "send", sample: screened };
}

/**
 * Where a screened fan-out stands on its broadcast's own HTML: wait for the
 * verdict (the judge re-queues the fan-out), go, or park every copy for an
 * operator: once the judge kept failing on a young sending domain, or when
 * a team past new's HTML sends readers to a new destination read as
 * phishing. A verdict that pauses or holds the team is read by the fan-out's
 * own checks.
 */
export async function broadcastScreen(
  db: Db,
  deps: MonitorDeps,
  input: { skeletonSampleId: string; domainId: string; now: Date },
): Promise<
  { action: "wait" } | { action: "go" } | { action: "park"; reason: "screening" | "destination" }
> {
  const [sample] = await db.select().from(ms).where(eq(ms.id, input.skeletonSampleId));
  if (!sample?.screening) return { action: "go" };
  const waiting = await unanswered(db, deps, sample, input);
  if (waiting === "wait") return { action: "wait" };
  if (waiting === "park") return { action: "park", reason: "screening" };
  const s = await deps.settings();
  if (
    waiting === null &&
    sample.destinations?.length &&
    destinationVerdictParks(sample, s) &&
    (await tierOf(db, s, sample.teamId, input.now)) !== "new"
  ) {
    return { action: "park", reason: "destination" };
  }
  return { action: "go" };
}

/** A screened email that went out without a verdict is judged afterwards, as unscreened mail is. */
export async function judgeAfterSend(
  db: Db,
  deps: MonitorDeps,
  sample: { id: string; teamId: string },
): Promise<void> {
  const [rearmed] = await db
    .update(ms)
    .set({ status: "pending", screening: false, errorClass: null, judgedAt: null, attempts: 0 })
    .where(and(eq(ms.id, sample.id), eq(ms.status, "unjudged")))
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

function scope(teamId: string, emailIds: readonly string[] | undefined): SQL | undefined {
  return and(eq(e.teamId, teamId), emailIds ? inArray(e.id, [...emailIds]) : undefined);
}

/**
 * Queued emails of the team waiting out the short wait a phishing-type
 * verdict from `holdLine` brings, not released from it yet.
 */
async function waitingOnVerdict(
  db: Db,
  input: { teamId: string; emailIds?: readonly string[] | undefined; holdLine: number },
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
        scope(input.teamId, input.emailIds),
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
 * a review hold parks is released with the hold, never here.
 */
export async function releaseWaitingEmails(
  db: Db,
  input: {
    teamId: string;
    emailIds?: readonly string[] | undefined;
    holdLine: number;
    now?: Date;
  },
): Promise<{ parked: number; queued: string[] }> {
  const now = input.now ?? new Date();
  const parked = await db
    .update(e)
    .set({ parkReason: null, screenReleasedAt: now })
    .where(
      and(
        scope(input.teamId, input.emailIds),
        eq(e.latestStatus, "queued_quota"),
        isNull(e.sentAt),
        inArray(e.parkReason, [...OPERATOR_PARK_REASONS]),
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
  // The operator vouched for where the mail leads: those destinations clear.
  const released = [...parked, ...queued].map((row) => row.id);
  if (released.length > 0) {
    const samples = await db
      .select({ destinations: ms.destinations })
      .from(ms)
      .where(and(inArray(ms.emailId, released), eq(ms.screening, true)));
    await clearDestinations(
      db,
      input.teamId,
      [...new Set(samples.flatMap((row) => row.destinations ?? []))],
      now,
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
  input: { teamId: string; emailIds?: readonly string[] | undefined; holdLine: number },
): Promise<number> {
  const waiting = await waitingOnVerdict(db, input);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows = await t
      .update(e)
      .set({ latestStatus: "canceled" })
      .where(
        or(
          and(scope(input.teamId, input.emailIds), parkedForReview()),
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
