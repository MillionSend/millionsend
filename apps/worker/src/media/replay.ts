import { env } from "@millionsend/config";
import {
  type AttachmentFlag,
  type AttachmentRejection,
  attachmentVerdict,
  DAY_MS,
  decryptEmailBody,
  getMonitorSettingsRow,
  type Keyring,
  linkDomain,
  type MonitorTier,
  monitorTier,
  opaqueFacts,
  openAttachments,
  registrableDomain,
  resolveMonitorSettings,
  resultRows,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { inArray, sql } from "drizzle-orm";
import { readMediaForJudge } from "./read.js";
import type { MediaDeps } from "./scan.js";

/**
 * Replays screening of images and attachments on stored mail: what the API
 * would now refuse, what would wait for a person while a team is new, which
 * emails are opaque, and where their QR and Pix codes point. Read-only, in a
 * read-only transaction: bodies are decrypted in memory and dropped, image
 * reading stays off and remote images are not fetched. The report holds
 * counts and team id prefixes only, never content, file names, addresses or
 * domain names.
 */

export interface ReplayOptions {
  days: number;
  /** Most emails opened; the newest candidates go first. */
  limit: number;
  now?: Date;
}

export type AgeBucket = "<7d" | "7-30d" | "30d-1y" | ">1y" | "unknown";

export interface ReplayTeam {
  /** The team id's first 8 characters. */
  team: string;
  tier: MonitorTier;
  paid: boolean;
  emails: number;
  opaque: number;
  refusedEmails: number;
  refused: Partial<Record<AttachmentRejection, number>>;
  /** Emails with a flagged file: parked for a team in "new", a sampling anomaly past it. */
  flaggedEmails: number;
  flagged: Partial<Record<AttachmentFlag, number>>;
  qrCodes: number;
  qrEmails: number;
  /** Distinct QR destinations by the age of their registrable domain. */
  qrDomains: Partial<Record<AgeBucket, number>>;
  /** Of those, the team's own verified domains. */
  qrOwnDomains: number;
  pix: { qr: number; text: number; emails: number };
  remoteImages: number;
}

export interface ReplayReport {
  days: number;
  limit: number;
  candidates: number;
  opened: number;
  teams: ReplayTeam[];
}

interface Candidate {
  id: string;
  team_id: string;
  created_at: Date | string;
  has_attachments: boolean;
  newer: number | string;
  plan: string;
  sent_total: number | string;
  first_send_at: Date | string | null;
}

const BATCH = 50;
const PAID_PLANS = new Set(["starter", "pro", "scale"]);

/** Fetching would tell a sender we looked and fire their tracking pixels: the replay stays offline. */
const offline = async (): Promise<never> => {
  throw new Error("the replay does not fetch remote images");
};

function ageBucket(registeredAt: Date | undefined, now: Date): AgeBucket {
  if (!registeredAt) return "unknown";
  const days = (now.getTime() - registeredAt.getTime()) / DAY_MS;
  if (days < 7) return "<7d";
  if (days < 30) return "7-30d";
  return days < 365 ? "30d-1y" : ">1y";
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/**
 * The emails to open: every one with attachments, and every one sent while
 * its team was in "new". The SQL keeps a superset of "new" (by send count
 * and first-send window); monitorTier decides exactly, on the team's send
 * count when the email was accepted.
 */
async function candidates(db: Db, since: Date): Promise<(Candidate & { tier: MonitorTier })[]> {
  const settings = resolveMonitorSettings(await getMonitorSettingsRow(db), env).settings;
  const rows = resultRows<Candidate>(
    await db.execute(sql`
      with recent as (
        select e.id, e.team_id, e.created_at, e.body_purged_at,
               e.attachments is not null as has_attachments,
               row_number() over (partition by e.team_id order by e.created_at desc, e.id desc) as newer
        from ${schema.emails} e
        where e.created_at >= ${since}
      )
      select r.id, r.team_id, r.created_at, r.has_attachments, r.newer, t.plan,
             coalesce(m.sent_total, 0) as sent_total, m.first_send_at
      from recent r
      join ${schema.teams} t on t.id = r.team_id
      left join ${schema.teamMonitor} m on m.team_id = r.team_id
      where r.body_purged_at is null
        and t.plan <> 'system'
        and (r.has_attachments
          or m.first_send_at is null
          or coalesce(m.sent_total, 0) - r.newer + 1 <= ${Math.max(settings.firstSends, settings.rampSends)}
          or r.created_at < m.first_send_at + make_interval(hours => ${settings.firstHours}))
      order by r.created_at desc, r.id desc
    `),
  );
  return rows
    .map((row) => {
      const sentTotal = Math.max(1, Number(row.sent_total) - Number(row.newer) + 1);
      const firstSendAt = row.first_send_at ? new Date(row.first_send_at) : null;
      const tier = monitorTier(
        {
          sentTotal,
          firstSendAt,
          plan: row.plan,
          flaggedRecently: false,
          overrideRate: null,
          overrideUntil: null,
          risk: null,
        },
        settings,
        new Date(row.created_at),
      );
      return { ...row, tier };
    })
    .filter((row) => row.has_attachments || row.tier === "new");
}

export async function replayMedia(
  db: Db,
  keyring: Keyring,
  opts: ReplayOptions,
  deps: MediaDeps = {},
): Promise<ReplayReport> {
  const now = opts.now ?? new Date();
  // Postgres refuses every write in a read-only transaction: the replay can't change a row.
  return db.transaction(
    async (tx) => {
      const t = tx as unknown as Db;
      const found = await candidates(t, new Date(now.getTime() - opts.days * DAY_MS));
      const chosen = found.slice(0, opts.limit);
      const tallies = new Map<string, ReplayTeam & { teamId: string; domains: Set<string> }>();
      // ponytail: one email at a time keeps the replay light on a live instance; read a few at
      // once if a month of mail takes too long.
      for (let i = 0; i < chosen.length; i += BATCH) {
        const batch = new Map(chosen.slice(i, i + BATCH).map((c) => [c.id, c]));
        const rows = await t
          .select()
          .from(schema.emails)
          .where(inArray(schema.emails.id, [...batch.keys()]));
        for (const email of rows) {
          const meta = batch.get(email.id);
          if (!meta || !email.bodyCiphertext || !email.bodyIv || !email.bodyWrappedDek) continue;
          if (email.bodyKeyVersion === null) continue;
          const key = `${email.teamId}:${meta.tier}`;
          const tally = tallies.get(key) ?? {
            teamId: email.teamId,
            team: email.teamId.slice(0, 8),
            tier: meta.tier,
            paid: PAID_PLANS.has(meta.plan),
            emails: 0,
            opaque: 0,
            refusedEmails: 0,
            refused: {},
            flaggedEmails: 0,
            flagged: {},
            qrCodes: 0,
            qrEmails: 0,
            qrDomains: {},
            qrOwnDomains: 0,
            pix: { qr: 0, text: 0, emails: 0 },
            remoteImages: 0,
            domains: new Set<string>(),
          };
          tallies.set(key, tally);
          const owner = { teamId: email.teamId, rowId: email.id };
          const body = await decryptEmailBody(
            {
              ciphertext: email.bodyCiphertext,
              iv: email.bodyIv,
              wrappedDek: email.bodyWrappedDek,
              keyVersion: email.bodyKeyVersion,
            },
            keyring,
            owner,
          );
          const attachments = email.attachments
            ? await openAttachments(email.attachments, keyring, owner)
            : [];
          const facts = opaqueFacts({ ...body, attachments: attachments.length });
          tally.emails++;
          if (facts.opaque) tally.opaque++;
          let refused = false;
          for (const file of attachments) {
            const verdict = attachmentVerdict({
              filename: file.filename,
              contentType: file.contentType,
              bytes: Buffer.from(file.content, "base64"),
            });
            if (verdict.action === "reject") {
              bump(tally.refused, verdict.rejection);
              refused = true;
            }
          }
          if (refused) tally.refusedEmails++;
          const readBodyImages = meta.tier === "new" || facts.opaque;
          const bodyImages = facts.imageRefs.map((ref) => ref.src);
          if (readBodyImages) {
            tally.remoteImages += bodyImages.filter((src) => /^https?:\/\//i.test(src)).length;
          }
          const media = await readMediaForJudge(
            { attachments, bodyImages, readBodyImages },
            { ...deps, vision: null, fetchImage: offline },
          );
          const flags = media.findings.files.flatMap((file) => file.flags);
          for (const flag of flags) bump(tally.flagged, flag);
          if (flags.length > 0) tally.flaggedEmails++;
          const qr = media.findings.links.filter((link) => link.source === "QR code");
          tally.qrCodes += qr.length;
          if (qr.length > 0) tally.qrEmails++;
          for (const link of qr) {
            const domain = linkDomain(link.url);
            if (domain) tally.domains.add(domain);
          }
          for (const pix of media.findings.pix) tally.pix[pix.from]++;
          if (media.findings.pix.length > 0) tally.pix.emails++;
        }
      }

      const registered = new Map<string, Date>();
      for (const row of await t
        .select({ name: schema.domains.name, registeredAt: schema.domains.registeredAt })
        .from(schema.domains)) {
        const domain = registrableDomain(row.name);
        const known = registered.get(domain);
        if (row.registeredAt && (!known || row.registeredAt < known)) {
          registered.set(domain, row.registeredAt);
        }
      }
      const teamIds = [...new Set([...tallies.values()].map((tally) => tally.teamId))];
      const own = new Map<string, Set<string>>();
      if (teamIds.length > 0) {
        for (const row of await t
          .select({ teamId: schema.domains.teamId, name: schema.domains.name })
          .from(schema.domains)
          .where(inArray(schema.domains.teamId, teamIds))) {
          const set = own.get(row.teamId) ?? new Set<string>();
          set.add(registrableDomain(row.name));
          own.set(row.teamId, set);
        }
      }
      const teams = [...tallies.values()].map(({ teamId, domains, ...tally }) => {
        for (const domain of domains) {
          bump(tally.qrDomains, ageBucket(registered.get(domain), now));
          if (own.get(teamId)?.has(domain)) tally.qrOwnDomains++;
        }
        return tally;
      });
      teams.sort((a, b) => b.emails - a.emails || a.team.localeCompare(b.team));
      return {
        days: opts.days,
        limit: opts.limit,
        candidates: found.length,
        opened: teams.reduce((n, team) => n + team.emails, 0),
        teams,
      };
    },
    { accessMode: "read only" },
  );
}

const listed = (counts: Partial<Record<string, number>>): string => {
  const parts = Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a, x], [b, y]) => (y ?? 0) - (x ?? 0) || a.localeCompare(b))
    .map(([name, n]) => `${name} ${n}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
};

const sum = (teams: readonly ReplayTeam[], pick: (team: ReplayTeam) => number) =>
  teams.reduce((n, team) => n + pick(team), 0);

function merged<K extends string>(
  teams: readonly ReplayTeam[],
  pick: (team: ReplayTeam) => Partial<Record<K, number>>,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const team of teams) {
    for (const [key, n] of Object.entries(pick(team)) as [K, number][]) bump(out, key, n);
  }
  return out;
}

const teamCount = (teams: readonly ReplayTeam[], has: (team: ReplayTeam) => boolean) =>
  new Set(teams.filter(has).map((team) => team.team)).size;

/** The report as printed: one line per team and tier, then one per rule. */
export function formatReplay(report: ReplayReport): string[] {
  const { teams } = report;
  const lines = [
    `Media replay, last ${report.days} days: ${report.opened} of ${report.candidates} candidate emails opened (limit ${report.limit}).`,
    "Read-only; image reading off; remote images not fetched. Teams by id prefix, tier at send, plan.",
    "",
  ];
  for (const team of teams) {
    const domains = Object.values(team.qrDomains).reduce((n, v) => n + (v ?? 0), 0);
    lines.push(
      `${team.team} ${team.tier} ${team.paid ? "paid" : "free"}: emails ${team.emails}, opaque ${team.opaque}, ` +
        `refused ${team.refusedEmails}${listed(team.refused)}, ` +
        `${team.tier === "new" ? "parked" : "flagged"} ${team.flaggedEmails}${listed(team.flagged)}, ` +
        `QR ${team.qrCodes} to domains ${domains}${listed(team.qrDomains)}, own ${team.qrOwnDomains}, ` +
        `Pix ${team.pix.qr + team.pix.text}`,
    );
  }
  const isNew = (team: ReplayTeam) => team.tier === "new";
  const newTeams = teams.filter(isNew);
  const older = teams.filter((team) => !isNew(team));
  const of = (group: readonly ReplayTeam[], count: (team: ReplayTeam) => number) =>
    `emails ${sum(group, count)}, teams ${teamCount(group, (team) => count(team) > 0)}`;
  lines.push(
    "",
    `Refused with 422 for every team: ${of(teams, (t) => t.refusedEmails)}${listed(merged(teams, (t) => t.refused))}.`,
    `Parked for a person while the team is new: ${of(newTeams, (t) => t.flaggedEmails)}${listed(merged(newTeams, (t) => t.flagged))}. Past "new", a sampling anomaly instead: ${of(older, (t) => t.flaggedEmails)}.`,
    `Opaque: ${of(teams, (t) => t.opaque)}; while the team was new: emails ${sum(newTeams, (t) => t.opaque)}.`,
    `QR codes: ${sum(teams, (t) => t.qrCodes)} decoded in ${of(teams, (t) => t.qrEmails)}; destination domains, distinct per team, by age${listed(merged(teams, (t) => t.qrDomains))}; the team's own: ${sum(teams, (t) => t.qrOwnDomains)}.`,
    `Pix codes: ${sum(teams, (t) => t.pix.qr + t.pix.text)} in ${of(teams, (t) => t.pix.emails)} (in QR codes ${sum(teams, (t) => t.pix.qr)}, as text ${sum(teams, (t) => t.pix.text)}).`,
    `Remote body images not fetched: ${sum(teams, (t) => t.remoteImages)}.`,
  );
  return lines;
}
