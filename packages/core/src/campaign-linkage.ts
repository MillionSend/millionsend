import { env } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { LinkMatch, LinkTrigger } from "@millionsend/db/schema";
import { and, desc, eq, inArray, isNotNull, isNull, ne, notExists, or } from "drizzle-orm";
import { loadMonitorState, monitorTier, teamMonitorRow } from "./abuse-monitor.js";
import { recordAudit } from "./audit.js";
import {
  type Fingerprint,
  type FingerprintMessage,
  fingerprintsMatch,
  messageFingerprints,
} from "./campaign-fingerprints.js";
import { decryptEmailBody } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import { getMonitorSettingsRow, resolveMonitorSettings } from "./monitor-settings.js";
import { mailboxIdentity } from "./suppressions.js";
import { type SuspensionReason, suspendTeam } from "./team-standing.js";

/** Stored emails read at a suspension, the latest of each sender and subject... */
const CAPTURE_EMAILS = 40;
/** ...found among this many of the team's latest. */
const CAPTURE_SCAN = 500;

const cf = schema.campaignFingerprints;
const links = schema.teamLinks;

/** The team's people: their mailboxes, and the IPs they signed up and were seen in a session from. */
async function peopleFingerprints(db: Db, teamId: string): Promise<Fingerprint[]> {
  const m = schema.teamMembers;
  const people = await db
    .select({ userId: m.userId, email: schema.user.email })
    .from(m)
    .innerJoin(schema.user, eq(schema.user.id, m.userId))
    .where(eq(m.teamId, teamId));
  const ids = people.map((person) => person.userId);
  if (ids.length === 0) return [];
  const su = schema.accountSignups;
  const s = schema.session;
  const ips = [
    ...(await db
      .select({ ip: su.ip })
      .from(su)
      .where(and(inArray(su.userId, ids), isNotNull(su.ip)))),
    ...(await db
      .selectDistinct({ ip: s.ipAddress })
      .from(s)
      .where(and(inArray(s.userId, ids), isNotNull(s.ipAddress), ne(s.ipAddress, "")))),
  ];
  return [
    ...people.map((person) => ({ kind: "address" as const, value: mailboxIdentity(person.email) })),
    ...[...new Set(ips.flatMap((row) => (row.ip ? [row.ip.toLowerCase()] : [])))].map((ip) => ({
      kind: "ip" as const,
      value: ip,
    })),
  ];
}

async function domainFingerprints(db: Db, teamId: string): Promise<Fingerprint[]> {
  const rows = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(eq(schema.domains.teamId, teamId));
  return rows.map((row) => ({ kind: "sending_domain" as const, value: row.name }));
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
      console.warn("campaign linkage: no keyring, stored bodies left unread", err);
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
        console.warn(`campaign linkage: body of email ${row.id} not opened`, err);
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
 * mailboxes and IPs, its domains, its cards, and from its latest stored mail
 * the sender names and domains, subjects, link domains, phone numbers and
 * visible-text hashes. A suspension for any other reason records nothing.
 * Best-effort, never thrown: a source that fails is logged and skipped, and
 * recordMissingFingerprints picks up a team left with none. Returns how
 * many fingerprints were new.
 */
export async function recordPhishingFingerprints(
  db: Db,
  input: { teamId: string; reason: SuspensionReason },
  sources: FingerprintSources = {},
): Promise<number> {
  if (input.reason !== "phishing") return 0;
  try {
    const [team] = await db
      .select({ name: schema.teams.name, customerId: schema.teams.stripeCustomerId })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId));
    if (!team) return 0;
    const prints = [
      ...(await peopleFingerprints(db, input.teamId)),
      ...(await domainFingerprints(db, input.teamId)),
      ...(await mailFingerprints(db, input.teamId, sources.keyring)),
    ];
    if (team.customerId && sources.cards) {
      try {
        for (const card of await sources.cards(team.customerId)) {
          prints.push({ kind: "card", value: card });
        }
      } catch (err) {
        console.warn(`campaign linkage: cards of team ${input.teamId} not read`, err);
      }
    }
    if (prints.length === 0) return 0;
    const inserted = await db
      .insert(cf)
      .values(
        prints.map((print) => ({
          teamId: input.teamId,
          teamName: team.name,
          kind: print.kind,
          value: print.value,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: cf.id });
    return inserted.length;
  } catch (err) {
    console.error(`campaign linkage: fingerprints of team ${input.teamId} not recorded`, err);
    return 0;
  }
}

/**
 * Teams suspended for phishing that have no fingerprints: suspended before
 * linkage existed, or whose capture failed. A few per run. Returns how many
 * were tried.
 */
export async function recordMissingFingerprints(
  db: Db,
  sources: FingerprintSources = {},
  limit = 5,
): Promise<number> {
  const t = schema.teams;
  const missing = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.suspensionReason, "phishing"),
        notExists(db.select({ id: cf.id }).from(cf).where(eq(cf.teamId, t.id))),
      ),
    )
    .limit(limit);
  for (const team of missing) {
    await recordPhishingFingerprints(db, { teamId: team.id, reason: "phishing" }, sources);
  }
  return missing.length;
}

export interface TeamLinkResult {
  /** Whether this link put the review hold on the team. */
  held: boolean;
  links: { teamId: string; teamName: string; matches: LinkMatch[] }[];
}

/**
 * Compares a new team with every team suspended for phishing (one that was
 * reinstated no longer counts): its people's mailboxes and IPs, its domains,
 * the card fingerprints passed in, and the message it is about to send. On
 * a match the team gets the review hold before it sends anything, unless the
 * hold policy is off: the review suspension, a `linked` flag its release
 * clears, and the team's own "held for review" audit row. The match is kept
 * in team_links, which the console shows and the worker mails the operator
 * about. A team is linked once, and only while it is new.
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
    console.error(`campaign linkage: team ${input.teamId} not checked (${input.trigger})`, err);
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
  const [linked] = await db
    .select({ teamId: links.teamId })
    .from(links)
    .where(eq(links.teamId, input.teamId))
    .limit(1);
  if (linked) return null;
  const { settings } = resolveMonitorSettings(
    await getMonitorSettingsRow(db),
    env as unknown as Record<string, unknown>,
  );
  const state = await loadMonitorState(db, await teamMonitorRow(db, input.teamId), input.now);
  if (monitorTier(state, settings, input.now) !== "new") return null;

  const mine: Fingerprint[] = [
    ...(await peopleFingerprints(db, input.teamId)),
    ...(await domainFingerprints(db, input.teamId)),
    ...(input.cards ?? []).map((card) => ({ kind: "card" as const, value: card })),
    ...(input.message ? messageFingerprints(input.message) : []),
  ];
  const t = schema.teams;
  const stored = await db
    .select({ teamId: cf.teamId, teamName: cf.teamName, kind: cf.kind, value: cf.value })
    .from(cf)
    .leftJoin(t, eq(t.id, cf.teamId))
    .where(and(ne(cf.teamId, input.teamId), or(isNull(t.id), eq(t.suspensionReason, "phishing"))))
    .orderBy(cf.kind, cf.value);
  const found = new Map<string, { teamName: string; matches: LinkMatch[] }>();
  for (const print of stored) {
    for (const own of mine) {
      if (!fingerprintsMatch(own, print)) continue;
      const entry = found.get(print.teamId) ?? { teamName: print.teamName, matches: [] };
      if (
        !entry.matches.some(
          (m) => m.kind === own.kind && m.value === own.value && m.matched === print.value,
        )
      ) {
        entry.matches.push({ kind: own.kind, value: own.value, matched: print.value });
      }
      found.set(print.teamId, entry);
    }
  }
  if (found.size === 0) return null;

  const held = await db.transaction(async (tx) => {
    const t2 = tx as unknown as Db;
    // A standing suspension, the content monitor's hold included, stays as it is.
    const holding =
      settings.autoHold &&
      (await suspendTeam(t2, {
        teamId: input.teamId,
        reason: "review",
        now: input.now,
        ifNotSuspended: true,
      }));
    const inserted = await t2
      .insert(links)
      .values(
        [...found].map(([linkedTeamId, entry]) => ({
          teamId: input.teamId,
          linkedTeamId,
          linkedTeamName: entry.teamName,
          matches: entry.matches,
          trigger: input.trigger,
          held: holding,
          createdAt: input.now,
        })),
      )
      .onConflictDoNothing()
      .returning({ linkedTeamId: links.linkedTeamId });
    if (inserted.length === 0) return null;
    await t2
      .insert(schema.teamFlags)
      .values({
        teamId: input.teamId,
        reason: "linked",
        detail: holding ? { suspension: true } : {},
        openedAt: input.now,
      })
      .onConflictDoNothing();
    return holding;
  });
  if (held === null) return null;
  if (held) {
    await recordAudit(db, {
      teamId: input.teamId,
      actor: "system",
      action: "team.held_for_review",
      target: { type: "team", id: input.teamId },
    });
  }
  return {
    held,
    links: [...found].map(([teamId, entry]) => ({ teamId, ...entry })),
  };
}
