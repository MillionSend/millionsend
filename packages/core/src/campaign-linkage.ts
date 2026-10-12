import { env } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { CampaignFingerprintKind, LinkMatch, LinkTrigger } from "@millionsend/db/schema";
import { and, asc, desc, eq, gt, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { loadMonitorState, monitorTier, teamMonitorRow } from "./abuse-monitor.js";
import { clearAbuseMarks } from "./account-signups.js";
import { recordAudit } from "./audit.js";
import {
  type Fingerprint,
  type FingerprintMessage,
  fingerprint,
  fingerprintsMatch,
  messageFingerprints,
} from "./campaign-fingerprints.js";
import { decryptEmailBody } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import { errorSummary } from "./error-summary.js";
import { sharedEgressIps } from "./ip-geo.js";
import { getMonitorSettingsRow, resolveMonitorSettings } from "./monitor-settings.js";
import { mailboxIdentity } from "./suppressions.js";
import { type SuspensionReason, suspendTeam } from "./team-standing.js";
import { DAY_MS } from "./utc-day.js";

/** Stored emails read at a suspension, the latest of each sender and subject... */
const CAPTURE_EMAILS = 40;
/** ...found among this many of the team's latest. */
const CAPTURE_SCAN = 500;
/** A team whose capture failed or found nothing is tried again after this long. */
const CAPTURE_RETRY_MS = DAY_MS;
/** Days a team suspended for phishing is remembered, from its suspension... */
export const FINGERPRINT_RETENTION_DAYS = 365;
/** ...and its people's IPs, which their providers soon hand to someone else. */
export const IP_FINGERPRINT_RETENTION_DAYS = 90;

/**
 * Evidence one person leaves, which holds a team on its own: a mailbox or a
 * card. Anything else holds only beside a second kind.
 */
const STRONG_KINDS: ReadonlySet<CampaignFingerprintKind> = new Set(["address", "card"]);

const cf = schema.campaignFingerprints;
const links = schema.teamLinks;
const failures = schema.campaignCaptureFailures;

/**
 * The team's people: their mailboxes, and the IPs they signed up from,
 * leaving out shared egress networks, where one address stands for crowds.
 */
async function peopleFingerprints(db: Db, teamId: string): Promise<Fingerprint[]> {
  const m = schema.teamMembers;
  const su = schema.accountSignups;
  const people = await db
    .select({ email: schema.user.email, ip: su.ip })
    .from(m)
    .innerJoin(schema.user, eq(schema.user.id, m.userId))
    .leftJoin(su, eq(su.userId, m.userId))
    .where(eq(m.teamId, teamId));
  const ips = [...new Set(people.flatMap((person) => (person.ip ? [person.ip] : [])))];
  const shared = await sharedEgressIps(db, ips);
  return [
    ...people.map((person) => fingerprint("address", mailboxIdentity(person.email))),
    ...ips.filter((ip) => !shared.has(ip)).map((ip) => fingerprint("ip", ip)),
  ];
}

/**
 * The team's domains. A suspended team's count only once verified: anyone
 * can add an unverified name, a real company's included, to have it kept.
 */
async function domainFingerprints(
  db: Db,
  teamId: string,
  opts: { verifiedOnly: boolean },
): Promise<Fingerprint[]> {
  const d = schema.domains;
  const rows = await db
    .select({ name: d.name })
    .from(d)
    .where(and(eq(d.teamId, teamId), opts.verifiedOnly ? eq(d.status, "verified") : undefined));
  return rows.map((row) => fingerprint("sending_domain", row.name));
}

/** What the team's latest stored mail carries; a body that cannot be opened gives its sender and subject only. */
async function mailFingerprints(
  db: Db,
  teamId: string,
  keyring: (() => Keyring) | undefined,
): Promise<Fingerprint[]> {
  const e = schema.emails;
  const rows = await db
    .select({
      id: e.id,
      from: e.from,
      subject: e.subject,
      ciphertext: e.bodyCiphertext,
      iv: e.bodyIv,
      wrappedDek: e.bodyWrappedDek,
      keyVersion: e.bodyKeyVersion,
      purgedAt: e.bodyPurgedAt,
    })
    .from(e)
    .where(eq(e.teamId, teamId))
    .orderBy(desc(e.createdAt))
    .limit(CAPTURE_SCAN);
  const seen = new Set<string>();
  const picked = rows.filter((row) => {
    const key = `${row.from}\n${row.subject}`;
    if (seen.has(key) || seen.size >= CAPTURE_EMAILS) return false;
    seen.add(key);
    return true;
  });
  let ring: Keyring | null = null;
  if (picked.some((row) => row.ciphertext && !row.purgedAt)) {
    try {
      ring = keyring?.() ?? null;
    } catch (err) {
      console.warn(`campaign linkage: no keyring, stored bodies left unread: ${errorSummary(err)}`);
    }
  }
  const prints: Fingerprint[] = [];
  for (const row of picked) {
    let body: { html: string | null; text: string | null } = { html: null, text: null };
    if (
      ring &&
      !row.purgedAt &&
      row.ciphertext &&
      row.iv &&
      row.wrappedDek &&
      row.keyVersion !== null
    ) {
      try {
        body = await decryptEmailBody(
          {
            ciphertext: row.ciphertext,
            iv: row.iv,
            wrappedDek: row.wrappedDek,
            keyVersion: row.keyVersion,
          },
          ring,
          { teamId, rowId: row.id },
        );
      } catch (err) {
        console.warn(`campaign linkage: body of email ${row.id} not opened: ${errorSummary(err)}`);
      }
    }
    prints.push(...messageFingerprints({ from: row.from, subject: row.subject, ...body }));
  }
  return prints;
}

export interface FingerprintSources {
  /** Opens stored bodies; asked for only when there is mail to read. */
  keyring?: (() => Keyring) | undefined;
  /** The fingerprints of the cards a Stripe customer paid with. */
  cards?: ((customerId: string) => Promise<string[]>) | undefined;
}

/**
 * What a team suspended for phishing leaves for linkage: its people's
 * mailboxes and sign-up IPs, its verified domains, its cards, and from its
 * latest stored mail the sender names and domains, subjects, link domains,
 * phone numbers and visible-text hashes. A suspension for any other reason
 * records nothing. Best-effort, never thrown: each fingerprint is written
 * on its own, so one that fails is logged and the rest are kept, and
 * recordMissingFingerprints picks up a team left with none. Returns how
 * many fingerprints were new.
 */
export async function recordPhishingFingerprints(
  db: Db,
  input: { teamId: string; reason: SuspensionReason },
  sources: FingerprintSources = {},
): Promise<number> {
  if (input.reason !== "phishing") return 0;
  let team: { name: string; customerId: string | null } | undefined;
  const prints = new Map<string, Fingerprint>();
  const keep = (print: Fingerprint) => prints.set(`${print.kind}\n${print.value}`, print);
  try {
    [team] = await db
      .select({ name: schema.teams.name, customerId: schema.teams.stripeCustomerId })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId));
    if (!team) return 0;
    for (const print of [
      ...(await peopleFingerprints(db, input.teamId)),
      ...(await domainFingerprints(db, input.teamId, { verifiedOnly: true })),
      ...(await mailFingerprints(db, input.teamId, sources.keyring)),
    ]) {
      keep(print);
    }
  } catch (err) {
    console.error(
      `campaign linkage: fingerprints of team ${input.teamId} not read: ${errorSummary(err)}`,
    );
    return 0;
  }
  if (team.customerId && sources.cards) {
    try {
      for (const card of await sources.cards(team.customerId)) keep(fingerprint("card", card));
    } catch (err) {
      console.warn(
        `campaign linkage: cards of team ${input.teamId} not read: ${errorSummary(err)}`,
      );
    }
  }
  let recorded = 0;
  for (const print of prints.values()) {
    try {
      const inserted = await db
        .insert(cf)
        .values({ teamId: input.teamId, teamName: team.name, kind: print.kind, value: print.value })
        .onConflictDoNothing()
        .returning({ id: cf.id });
      recorded += inserted.length;
    } catch (err) {
      console.warn(
        `campaign linkage: a ${print.kind} fingerprint of team ${input.teamId} not recorded: ${errorSummary(err)}`,
      );
    }
  }
  return recorded;
}

/**
 * Teams suspended for phishing that have no fingerprints: suspended before
 * linkage existed, or whose capture failed. A few per run, the never-tried
 * and longest-suspended first; one that comes to nothing is stamped and
 * left alone for a day, so failing teams never take every slot. Returns
 * how many were tried.
 */
export async function recordMissingFingerprints(
  db: Db,
  sources: FingerprintSources = {},
  opts: { limit?: number; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const t = schema.teams;
  const missing = await db
    .select({ id: t.id })
    .from(t)
    .leftJoin(failures, eq(failures.teamId, t.id))
    .where(
      and(
        eq(t.suspensionReason, "phishing"),
        notExists(db.select({ id: cf.id }).from(cf).where(eq(cf.teamId, t.id))),
        or(
          isNull(failures.failedAt),
          lt(failures.failedAt, new Date(now.getTime() - CAPTURE_RETRY_MS)),
        ),
      ),
    )
    .orderBy(sql`${failures.failedAt} asc nulls first`, asc(t.suspendedAt), asc(t.id))
    .limit(opts.limit ?? 5);
  for (const team of missing) {
    const recorded = await recordPhishingFingerprints(
      db,
      { teamId: team.id, reason: "phishing" },
      sources,
    );
    if (recorded > 0) {
      await db.delete(failures).where(eq(failures.teamId, team.id));
    } else {
      await db
        .insert(failures)
        .values({ teamId: team.id, failedAt: now })
        .onConflictDoUpdate({ target: failures.teamId, set: { failedAt: now } });
    }
  }
  return missing.length;
}

/**
 * A reinstated team's abuse records go: its fingerprints, the backfill's
 * stamp, and its people's abuse marks (clearAbuseMarks).
 */
export async function forgetAbuseRecords(db: Db, teamId: string): Promise<void> {
  await db.delete(cf).where(eq(cf.teamId, teamId));
  await db.delete(failures).where(eq(failures.teamId, teamId));
  await clearAbuseMarks(db, teamId);
}

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/**
 * The retention sweep's part: a suspended team's fingerprints go 12 months
 * after its suspension, its people's IPs after 90 days. Returns how many
 * went.
 */
export async function purgeCampaignFingerprints(db: Db, now: Date = new Date()): Promise<number> {
  const t = schema.teams;
  const since = sql`coalesce((select ${t.suspendedAt} from ${t} where ${t.id} = ${cf.teamId}), ${cf.createdAt})`;
  const purged = await db
    .delete(cf)
    .where(
      or(
        lt(since, daysBefore(now, FINGERPRINT_RETENTION_DAYS)),
        and(eq(cf.kind, "ip"), lt(since, daysBefore(now, IP_FINGERPRINT_RETENTION_DAYS))),
      ),
    )
    .returning({ id: cf.id });
  return purged.length;
}

/** Whether one suspended team's evidence holds the team: a strong kind, or two kinds (a domain counts once, sent from or linked to). */
function holds(matches: readonly LinkMatch[]): boolean {
  if (matches.some((match) => STRONG_KINDS.has(match.kind))) return true;
  const kinds = matches.map((match) =>
    match.kind === "link_domain" ? "sending_domain" : match.kind,
  );
  return new Set(kinds).size >= 2;
}

export interface TeamLinkResult {
  /** Whether this call put the review hold on the team. */
  held: boolean;
  links: { teamId: string; teamName: string; matches: LinkMatch[] }[];
}

/**
 * Compares a new team with every team suspended for phishing (one that was
 * reinstated no longer counts): its people's mailboxes and sign-up IPs, its
 * domains, the card fingerprints passed in, and the message it is about to
 * send. What matches is kept in team_links, which the console shows and the
 * worker mails the operator about; nothing the team can see changes. Only
 * at a send ("send") does the team get the review hold, which parks its
 * mail silently, and only when the evidence from one suspended team, this
 * call's and what earlier calls kept, includes a mailbox or a card, or two
 * kinds: an IP, a domain or one kind of content alone is not enough. The
 * hold policy must be on, and a team held once, or released by an operator
 * after any review hold, is not held again. Only new teams are compared.
 *
 * Safe to call on every send of a new team: with no team ever suspended for
 * phishing it costs one query, and a failure is logged, never thrown.
 */
export async function linkTeam(
  db: Db,
  input: {
    teamId: string;
    trigger: LinkTrigger;
    message?: FingerprintMessage | undefined;
    cards?: readonly string[] | undefined;
    now?: Date | undefined;
  },
): Promise<TeamLinkResult | null> {
  try {
    return await link(db, { ...input, now: input.now ?? new Date() });
  } catch (err) {
    console.error(
      `campaign linkage: team ${input.teamId} not checked (${input.trigger}): ${errorSummary(err)}`,
    );
    return null;
  }
}

async function link(
  db: Db,
  input: {
    teamId: string;
    trigger: LinkTrigger;
    message?: FingerprintMessage | undefined;
    cards?: readonly string[] | undefined;
    now: Date;
  },
): Promise<TeamLinkResult | null> {
  const [anyPrint] = await db.select({ id: cf.id }).from(cf).limit(1);
  if (!anyPrint) return null;
  const known = await db
    .select({
      linkedTeamId: links.linkedTeamId,
      linkedTeamName: links.linkedTeamName,
      matches: links.matches,
      held: links.held,
    })
    .from(links)
    .where(eq(links.teamId, input.teamId));
  if (known.some((row) => row.held)) return null;
  const { settings } = resolveMonitorSettings(
    await getMonitorSettingsRow(db),
    env as unknown as Record<string, unknown>,
  );
  const monitor = await teamMonitorRow(db, input.teamId);
  const state = await loadMonitorState(db, monitor, input.now);
  if (monitorTier(state, settings, input.now) !== "new") return null;

  const mine: Fingerprint[] = [
    ...(await peopleFingerprints(db, input.teamId)),
    ...(await domainFingerprints(db, input.teamId, { verifiedOnly: false })),
    ...(input.cards ?? []).map((card) => fingerprint("card", card)),
    ...(input.message ? messageFingerprints(input.message) : []),
  ];
  const t = schema.teams;
  const stored = await db
    .select({ teamId: cf.teamId, teamName: cf.teamName, kind: cf.kind, value: cf.value })
    .from(cf)
    .leftJoin(t, eq(t.id, cf.teamId))
    .where(
      and(
        ne(cf.teamId, input.teamId),
        or(isNull(t.id), eq(t.suspensionReason, "phishing")),
        or(
          ne(cf.kind, "ip"),
          gt(
            sql`coalesce(${t.suspendedAt}, ${cf.createdAt})`,
            daysBefore(input.now, IP_FINGERPRINT_RETENTION_DAYS),
          ),
        ),
      ),
    )
    .orderBy(cf.kind, cf.value);
  const found = new Map(
    known.map((row) => [
      row.linkedTeamId,
      { teamName: row.linkedTeamName, matches: [...row.matches], changed: false },
    ]),
  );
  for (const print of stored) {
    for (const own of mine) {
      if (!fingerprintsMatch(own, print)) continue;
      const entry = found.get(print.teamId) ?? {
        teamName: print.teamName,
        matches: [],
        changed: false,
      };
      if (
        !entry.matches.some(
          (m) => m.kind === own.kind && m.value === own.value && m.matched === print.value,
        )
      ) {
        entry.matches.push({ kind: own.kind, value: own.value, matched: print.value });
        entry.changed = true;
      }
      found.set(print.teamId, entry);
    }
  }
  if (found.size === 0) return null;
  const result = (held: boolean): TeamLinkResult => ({
    held,
    links: [...found].map(([teamId, entry]) => ({
      teamId,
      teamName: entry.teamName,
      matches: entry.matches,
    })),
  });
  // An operator who released an earlier review hold has already weighed the team.
  const holding =
    input.trigger === "send" &&
    settings.autoHold &&
    monitor.heldAt === null &&
    [...found.values()].some((entry) => holds(entry.matches));
  if (!holding && ![...found.values()].some((entry) => entry.changed)) return result(false);

  const held = await db.transaction(async (tx) => {
    const t2 = tx as unknown as Db;
    // A standing suspension, the content monitor's hold included, stays as it is.
    const holdingNow =
      holding &&
      (await suspendTeam(t2, {
        teamId: input.teamId,
        reason: "review",
        now: input.now,
        ifNotSuspended: true,
      }));
    for (const [linkedTeamId, entry] of found) {
      const heldBy = holdingNow && holds(entry.matches);
      if (!entry.changed && !heldBy) continue;
      await t2
        .insert(links)
        .values({
          teamId: input.teamId,
          linkedTeamId,
          linkedTeamName: entry.teamName,
          matches: entry.matches,
          trigger: input.trigger,
          held: heldBy,
          createdAt: input.now,
        })
        .onConflictDoUpdate({
          target: [links.teamId, links.linkedTeamId],
          set: {
            matches: entry.matches,
            held: sql`${links.held} or ${heldBy}`,
            // A hold is news again for the operator, who heard of the record before.
            ...(heldBy ? { alertedAt: null } : {}),
          },
        });
    }
    await t2
      .insert(schema.teamFlags)
      .values({ teamId: input.teamId, reason: "linked", detail: {}, openedAt: input.now })
      .onConflictDoNothing();
    if (holdingNow) {
      // The release clears the flag a hold opened.
      await t2
        .update(schema.teamFlags)
        .set({ detail: { suspension: true } })
        .where(
          and(
            eq(schema.teamFlags.teamId, input.teamId),
            eq(schema.teamFlags.status, "open"),
            eq(schema.teamFlags.reason, "linked"),
          ),
        );
    }
    return holdingNow;
  });
  if (held) {
    await recordAudit(db, {
      teamId: input.teamId,
      actor: "system",
      action: "team.held_for_review",
      target: { type: "team", id: input.teamId },
    });
  }
  return result(held);
}
