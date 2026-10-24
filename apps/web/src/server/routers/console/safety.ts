import { contentRevealOn, env } from "@millionsend/config";
import {
  CHECKS,
  CONTENT_REVEAL_FIELDS,
  CONTENT_REVEAL_JUSTIFICATION_MAX,
  CONTENT_REVEAL_JUSTIFICATION_MIN,
  CONTENT_REVEAL_MEDIA_FIELDS,
  CONTENT_REVEAL_ONE_MESSAGE_REASONS,
  CONTENT_REVEAL_REASONS,
  CONTENT_REVEAL_SCOPES,
  cancelWaitingEmails,
  contentRevealExpiry,
  declineLimitRequest,
  decryptEmailBody,
  emailRecipientsSql,
  fetchAccountScore,
  fetchContentFactors,
  fetchDeliverabilityHealth,
  getMonitorSettingsRow,
  heldByNewDomainLimit,
  isHoldVerdict,
  listLimitRequests,
  OPERATOR_PARK_REASONS,
  openMediaReview,
  parseAuditActor,
  recentMonitorSamples,
  redactRevealedText,
  releaseWaitingEmails,
  renderRevealedBody,
  renderRevealedMedia,
  resolveMonitorSettings,
  setWarmupTrust,
  TEAM_FLAG_REASONS,
  teamMonitorOverview,
  teamWarmupOverview,
} from "@millionsend/core";
import { counterComplaintSent, GUARDRAIL_WINDOW_DAYS } from "@millionsend/core/deliverability";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { judgeStatus, monitorSettingsNow } from "../../console/monitor";
import { getKeyring } from "../../keyring";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../../keyset";
import { enqueueEmailSend } from "../../queue";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, kickQuotaDrain, loadTeam, type OperatorCtx } from "./shared";

const f = schema.teamFlags;
const t = schema.teams;
const st = schema.teamStandings;
const teamRegion = sql<
  string | null
>`(select d.region from ${schema.domains} d where d.team_id = ${t}."id" order by d.verified_at desc nulls last, d.created_at desc limit 1)`;
// Whether the standing's own 7-day window, as of its run, held a send that
// could draw a complaint: over none, the stored complaint rate reads 0.
const uc = schema.usageCounters;
const complaintSends7d = sql<boolean>`exists (select 1 from ${uc} where ${uc.teamId} = ${t.id} and ${counterComplaintSent} > 0 and ${uc.day} between (${st.computedAt} at time zone 'UTC')::date - ${GUARDRAIL_WINDOW_DAYS - 1}::int and (${st.computedAt} at time zone 'UTC')::date)`;

const SORT_KEYS = [
  "name",
  "type",
  "risk",
  "score",
  "guardrail",
  "reason",
  "status",
  "since",
] as const;
const planRank = sql<number>`case ${t.plan}::text when 'free' then 0 when 'starter' then 1 when 'pro' then 2 when 'scale' then 3 else 4 end`;
const SORT_EXPR: Record<(typeof SORT_KEYS)[number], SQL | AnyPgColumn> = {
  name: t.name,
  type: planRank,
  risk: sql`${st.monitorRisk}`,
  score: sql`${st.scoreTenths}`,
  guardrail: sql`case ${st.guardrail} when 'warning' then 1 when 'paused' then 2 else 0 end`,
  reason: sql`${f.reason}::text`,
  status: sql`case when ${t.suspendedAt} is not null then 2 when ${f.status} = 'open' then 0 else 1 end`,
  since: f.openedAt,
};

/** Emails of the last 7 days whose insight row has a failing critical or major check. */
const FLAGGED_EMAIL_DAYS = 7;
const CRITICAL_OR_MAJOR = CHECKS.filter(
  (c) => c.severity === "critical" || c.severity === "major",
).map((c) => c.id);

const g = schema.contentAccessGrants;

/** The window the review page shows and a whole-window grant covers. */
function flaggedSince(now: Date): Date {
  return new Date(now.getTime() - FLAGGED_EMAIL_DAYS * 86_400_000);
}

/**
 * The flagged emails of a team's window: one row per sent email with a
 * failing check, a broadcast's recipients sharing its insights row, then the
 * unsent ones a phishing-type verdict stopped before SES, which have no
 * insights yet, and the held ones screening kept a media review of, however
 * long they have waited. The review page lists these and a grant may only
 * ever name ids from here.
 */
async function flaggedEmails(db: Db, teamId: string, since: Date, holdLine: number) {
  const e = schema.emails;
  const i = schema.emailInsights;
  const ms = schema.monitorSamples;
  const recipients = sql<number>`jsonb_array_length(${e.to})`;
  const sent = await db
    .select({
      id: e.id,
      sentAt: e.sentAt,
      from: e.from,
      recipients,
      broadcastId: e.broadcastId,
      checks: i.checks,
    })
    .from(e)
    .innerJoin(
      i,
      or(eq(i.emailId, e.id), and(isNotNull(e.broadcastId), eq(i.broadcastId, e.broadcastId))),
    )
    .where(
      and(
        eq(e.teamId, teamId),
        sql`${e.sentAt} >= ${since}`,
        sql`exists (select 1 from jsonb_array_elements(${i.checks}) c where c->>'status' = 'fail' and c->>'severity' in ('critical', 'major'))`,
      ),
    )
    .orderBy(desc(e.sentAt))
    .limit(50);
  const held = await db
    .select({
      id: e.id,
      sentAt: e.sentAt,
      from: e.from,
      recipients,
      broadcastId: e.broadcastId,
      score: ms.score,
      verdict: ms.verdict,
      categories: ms.categories,
      reasons: ms.reasons,
    })
    .from(e)
    .innerJoin(ms, eq(ms.emailId, e.id))
    .where(
      and(
        eq(e.teamId, teamId),
        isNull(e.sentAt),
        inArray(e.latestStatus, ["queued", "queued_quota"]),
        eq(ms.status, "judged"),
        sql`${ms.judgedAt} >= ${since}`,
        sql`${ms.score} >= ${holdLine}`,
      ),
    )
    .orderBy(desc(e.createdAt))
    .limit(50);
  const withMedia = await db
    .select({ id: e.id, sentAt: e.sentAt, from: e.from, recipients, broadcastId: e.broadcastId })
    .from(e)
    .where(
      and(
        eq(e.teamId, teamId),
        isNull(e.sentAt),
        eq(e.latestStatus, "queued_quota"),
        isNotNull(e.media),
      ),
    )
    .orderBy(desc(e.createdAt))
    .limit(50);
  const unsent = held.filter((row) => isHoldVerdict(row, holdLine));
  const listed = new Set(unsent.map((row) => row.id));
  return [
    ...[...unsent, ...withMedia.filter((row) => !listed.has(row.id))].map((row) => ({
      id: row.id,
      sentAt: row.sentAt,
      from: row.from,
      recipients: row.recipients,
      broadcastId: row.broadcastId,
      checks: [] as schema.EmailInsightCheck[],
    })),
    ...sent,
  ];
}

/** Waiting emails the review list shows per team; a group's actions reach every one of them. */
const WAITING_SHOWN_PER_TEAM = 20;

/** Why an email waits, as the review list words it. */
type WaitingWhy = "held" | "verdict" | "outage" | "destination" | "media" | "recipient";

/** A queued row without a park reason waits out a verdict's short wait. */
function waitingWhy(parkReason: string | null): WaitingWhy {
  return parkReason === "review"
    ? "held"
    : parkReason === "screening"
      ? "outage"
      : parkReason === "destination"
        ? "destination"
        : parkReason === "media"
          ? "media"
          : parkReason === "recipient"
            ? "recipient"
            : "verdict";
}

/**
 * The review list: every unsent email screening stopped before SES, newest
 * first, grouped by team. Parked for an operator (a judge that kept failing
 * on a young domain, content it could not read), parked behind a review
 * hold still pending, or waiting out a phishing-type verdict's short wait.
 */
async function waitingEmails(db: Db, holdLine: number, teamId?: string) {
  const e = schema.emails;
  const ms = schema.monitorSamples;
  const fields = {
    id: e.id,
    teamId: e.teamId,
    createdAt: e.createdAt,
    from: e.from,
    recipients: emailRecipientsSql(),
    broadcastId: e.broadcastId,
    parkReason: e.parkReason,
    score: ms.score,
    verdict: ms.verdict,
    categories: ms.categories,
    reasons: ms.reasons,
    destinations: ms.destinations,
    media: sql<boolean>`${e.media} is not null`,
  };
  const parked = and(
    teamId ? eq(e.teamId, teamId) : undefined,
    eq(e.latestStatus, "queued_quota"),
    isNull(e.sentAt),
    or(
      inArray(e.parkReason, [...OPERATOR_PARK_REASONS]),
      and(eq(e.parkReason, "review"), eq(t.suspensionReason, "review")),
    ),
  );
  const parkedRows = await db
    .select(fields)
    .from(e)
    .innerJoin(t, eq(t.id, e.teamId))
    .leftJoin(ms, and(eq(ms.emailId, e.id), eq(ms.screening, true)))
    .where(parked)
    .orderBy(desc(e.createdAt))
    .limit(500);
  const parkedTotals = await db
    .select({ teamId: e.teamId, n: sql<number>`count(*)::int` })
    .from(e)
    .innerJoin(t, eq(t.id, e.teamId))
    .where(parked)
    .groupBy(e.teamId);
  // A verdict's short wait lasts minutes: few rows, read whole.
  const waitingRows = (
    await db
      .select(fields)
      .from(e)
      .innerJoin(ms, and(eq(ms.emailId, e.id), eq(ms.screening, true)))
      .where(
        and(
          teamId ? eq(e.teamId, teamId) : undefined,
          eq(e.latestStatus, "queued"),
          isNull(e.sentAt),
          isNull(e.screenReleasedAt),
          eq(ms.status, "judged"),
          sql`${ms.score} >= ${holdLine}`,
        ),
      )
  ).filter((row) => isHoldVerdict(row, holdLine));
  const shown = [...parkedRows, ...waitingRows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const totalOf = (id: string) =>
    (parkedTotals.find((row) => row.teamId === id)?.n ?? 0) +
    waitingRows.filter((row) => row.teamId === id).length;
  const teamIds = [...new Set(shown.map((row) => row.teamId))];
  const teams =
    teamIds.length === 0
      ? []
      : await db
          .select({
            id: t.id,
            name: t.name,
            logoUrl: t.logoUrl,
            plan: sql<string>`${t.plan}::text`,
            planQuota: t.planQuota,
            suspendedAt: t.suspendedAt,
            suspensionReason: t.suspensionReason,
            broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
          })
          .from(t)
          .where(inArray(t.id, teamIds));
  return teams
    .map((team) => {
      const emails = shown.filter((row) => row.teamId === team.id);
      return {
        team,
        total: totalOf(team.id),
        newestAt: emails[0]?.createdAt ?? new Date(0),
        emails: emails.slice(0, WAITING_SHOWN_PER_TEAM).map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          from: row.from,
          recipients: row.recipients,
          broadcastId: row.broadcastId,
          why: waitingWhy(row.parkReason),
          score: row.verdict === null ? null : row.score,
          reasons: row.reasons ?? [],
          destinations: row.destinations ?? [],
          media: row.media,
        })),
      };
    })
    .sort((a, b) => b.newestAt.getTime() - a.newestAt.getTime());
}

/** Every content procedure refuses the same way while the feature is off. */
function assertContentRevealOn(): void {
  if (!contentRevealOn()) throw new TRPCError({ code: "FORBIDDEN", message: "off" });
}

/**
 * The email a live grant of this operator names, for one view of its
 * content. Someone else's grant reads as no grant at all.
 */
async function grantedEmail(ctx: OperatorCtx, input: { grantId: string; emailId: string }) {
  assertContentRevealOn();
  const [grant] = await ctx.db.select().from(g).where(eq(g.id, input.grantId));
  if (!grant || grant.operatorUserId !== ctx.operator.id) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  const now = new Date();
  if (grant.expiresAt <= now) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "expired" });
  }
  if (!grant.emailIds.includes(input.emailId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "not_in_grant" });
  }
  const [email] = await ctx.db
    .select()
    .from(schema.emails)
    .where(and(eq(schema.emails.id, input.emailId), eq(schema.emails.teamId, grant.teamId)));
  if (!email) throw new TRPCError({ code: "NOT_FOUND" });
  return { grant, email, now };
}

/** Counts one view on the grant, which is the record of how often the content was read. */
async function countView(
  ctx: OperatorCtx,
  grant: { id: string; viewCount: number },
  now: Date,
): Promise<number> {
  const [counted] = await ctx.db
    .update(g)
    .set({ viewCount: sql`${g.viewCount} + 1`, lastViewedAt: now })
    .where(eq(g.id, grant.id))
    .returning({ viewCount: g.viewCount });
  return counted?.viewCount ?? grant.viewCount + 1;
}

/** The digest sealMediaReview keeps beside a review's ciphertext. */
const mediaDigest = sql<string | null>`(${schema.emails.media}::jsonb ->> 'digest')`;

/**
 * The team's emails parked for an operator that screening read the same
 * images and files from as this one (a blast's copies), itself included
 * while it waits; none when it has no media review.
 */
async function sameMediaParked(
  db: Db,
  teamId: string,
  emailId: string,
  parkedBefore?: Date,
): Promise<string[]> {
  const e = schema.emails;
  const [own] = await db
    .select({ digest: mediaDigest })
    .from(e)
    .where(and(eq(e.id, emailId), eq(e.teamId, teamId)));
  if (!own?.digest) return [];
  // ponytail: parses every parked review of the team on each call; an indexed
  // digest column if held blasts grow past a few thousand emails.
  const rows = await db
    .select({ id: e.id })
    .from(e)
    .where(
      and(
        eq(e.teamId, teamId),
        eq(e.latestStatus, "queued_quota"),
        isNull(e.sentAt),
        inArray(e.parkReason, [...OPERATOR_PARK_REASONS]),
        sql`${mediaDigest} = ${own.digest}`,
        parkedBefore ? or(isNull(e.parkedAt), lte(e.parkedAt, parkedBefore)) : undefined,
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * The review list's Release and its instance audit row: these emails of
 * the team, or every one parked by `parkedBefore`, when the operator was
 * shown the list. A team held for review is released with its hold, from
 * its review page.
 */
async function releaseEmails(
  ctx: OperatorCtx,
  team: { id: string; name: string; suspendedAt: Date | null },
  pick: { emailIds: string[] } | { parkedBefore: Date },
): Promise<{ released: number }> {
  if (team.suspendedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "held" });
  if ("emailIds" in pick && pick.emailIds.length === 0) return { released: 0 };
  const released = await releaseWaitingEmails(ctx.db, {
    teamId: team.id,
    ...pick,
    holdLine: (await monitorSettingsNow(ctx.db)).holdRepeatScore,
  });
  for (const emailId of released.queued) await enqueueEmailSend(emailId);
  if (released.parked > 0) await kickQuotaDrain();
  const count = released.parked + released.queued.length;
  if (count > 0) {
    await auditOperator(ctx, {
      teamId: null,
      action: "screening.released",
      target: { type: "team", id: team.id },
      metadata: { team: team.name, emails: count },
    });
  }
  return { released: count };
}

/** Which waiting emails an action takes: the ones named, or all parked by a time the operator saw. */
const waitingPick = z
  .object({
    teamId: z.uuid(),
    emailIds: z.array(z.uuid()).min(1).max(500).optional(),
    parkedBefore: z.date().optional(),
  })
  .refine((input) => (input.emailIds === undefined) !== (input.parkedBefore === undefined), {
    message: "emails_or_parked_before",
  });

export const consoleSafetyRouter = router({
  list: operatorProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        status: z.enum(["open", "cleared", "suspended", "all"]).default("open"),
        reason: z.enum(TEAM_FLAG_REASONS).optional(),
        region: z.string().max(32).optional(),
        sort: z.enum(SORT_KEYS).default("since"),
        dir: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters: (SQL | undefined)[] = [];
      if (input.search) {
        const like = `%${escapeLike(input.search)}%`;
        filters.push(
          or(
            ilike(t.name, like),
            ilike(t.slug, like),
            sql`exists (select 1 from ${schema.teamMembers} m join ${schema.user} u on u.id = m.user_id where m.team_id = ${t}."id" and u.email ilike ${like})`,
            sql`exists (select 1 from ${schema.domains} d where d.team_id = ${t}."id" and d.name ilike ${like})`,
          ),
        );
      }
      if (input.status === "open") filters.push(eq(f.status, "open"));
      else if (input.status === "cleared") filters.push(eq(f.status, "cleared"));
      else if (input.status === "suspended") filters.push(isNotNull(t.suspendedAt));
      if (input.reason) filters.push(eq(f.reason, input.reason));
      if (input.region) filters.push(sql`${teamRegion} = ${input.region}`);
      const where = filters.length > 0 ? and(...filters) : undefined;
      const expr = SORT_EXPR[input.sort];
      const order =
        input.dir === "asc" ? sql`${expr} asc nulls last` : sql`${expr} desc nulls last`;
      const [rows, [count], [open]] = await Promise.all([
        ctx.db
          .select({
            id: f.id,
            teamId: t.id,
            name: t.name,
            slug: t.slug,
            logoUrl: t.logoUrl,
            plan: sql<string>`${t.plan}::text`,
            planQuota: t.planQuota,
            reason: f.reason,
            detail: f.detail,
            note: f.note,
            status: f.status,
            openedBy: f.openedBy,
            openedAt: f.openedAt,
            clearedAt: f.clearedAt,
            region: teamRegion,
            suspendedAt: t.suspendedAt,
            suspensionReason: t.suspensionReason,
            broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
            scoreTenths: st.scoreTenths,
            guardrail: st.guardrail,
            guardrailMetric: st.guardrailMetric,
            complaintRate7d: st.complaintRate7d,
            hardBounceRate7d: st.hardBounceRate7d,
            sent7d: st.sent7d,
            complaintSends7d,
            monitorRisk: st.monitorRisk,
          })
          .from(f)
          .innerJoin(t, eq(t.id, f.teamId))
          .leftJoin(st, eq(st.teamId, t.id))
          .where(where)
          .orderBy(order, desc(f.openedAt), asc(f.id))
          .limit(input.limit + 1)
          .offset(input.offset),
        ctx.db
          .select({ total: sql<number>`count(*)::int` })
          .from(f)
          .innerJoin(t, eq(t.id, f.teamId))
          .leftJoin(st, eq(st.teamId, t.id))
          .where(where),
        ctx.db
          .select({
            open: sql<number>`count(*) filter (where ${f.status} = 'open')::int`,
            guardrailPaused: sql<number>`count(*) filter (where ${f.status} = 'open' and ${st.guardrail} = 'paused')::int`,
            suspended: sql<number>`(select count(*) from ${t} where ${t.suspendedAt} is not null)::int`,
            revealsThisWeek: sql<number>`(select count(*) from ${g} where ${g.createdAt} >= now() - interval '7 days')::int`,
          })
          .from(f)
          .innerJoin(t, eq(t.id, f.teamId))
          .leftJoin(st, eq(st.teamId, t.id)),
      ]);
      const { settings } = resolveMonitorSettings(
        await getMonitorSettingsRow(ctx.db),
        env as unknown as Record<string, unknown>,
      );
      return {
        items: rows.slice(0, input.limit),
        total: count?.total ?? 0,
        nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
        counts: open ?? { open: 0, guardrailPaused: 0, suspended: 0, revealsThisWeek: 0 },
        contentReveal: contentRevealOn(),
        thresholds: { flagRisk: settings.flagRisk, alertRisk: settings.alertRisk },
      };
    }),

  /** The review page: the team, its flag, a fresh standing, the failing checks and the flagged emails. */
  review: operatorProcedure.input(z.object({ teamId: z.uuid() })).query(async ({ ctx, input }) => {
    const team = await loadTeam(ctx.db, input.teamId);
    const now = new Date();
    const since = flaggedSince(now);
    const judge = judgeStatus();
    const { settings: monitorSettings } = resolveMonitorSettings(
      await getMonitorSettingsRow(ctx.db),
      env as unknown as Record<string, unknown>,
    );
    const [
      flags,
      health,
      score,
      factors,
      owners,
      region,
      contacts,
      flagged,
      audit,
      monitor,
      samples,
      grants,
      warmup,
      requests,
    ] = await Promise.all([
      ctx.db.select().from(f).where(eq(f.teamId, team.id)).orderBy(desc(f.openedAt)).limit(10),
      fetchDeliverabilityHealth(ctx.db, team.id, { now }),
      fetchAccountScore(ctx.db, team.id, { now }),
      fetchContentFactors(ctx.db, team.id, { now }),
      ctx.db
        .select({ email: schema.user.email, name: schema.user.name })
        .from(schema.teamMembers)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
        .where(and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.role, "owner")))
        .orderBy(asc(schema.teamMembers.createdAt)),
      ctx.db
        .select({
          region: teamRegion,
          domains: sql<number>`(select count(*)::int from ${schema.domains} d where d.team_id = ${t}."id" and d.status = 'verified')`,
        })
        .from(t)
        .where(eq(t.id, team.id))
        .then((r) => r[0] ?? { region: null, domains: 0 }),
      ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.contacts)
        .where(eq(schema.contacts.teamId, team.id))
        .then((r) => r[0]?.n ?? 0),
      flaggedEmails(ctx.db, team.id, since, monitorSettings.holdRepeatScore),
      ctx.db
        .select({
          id: schema.auditLog.id,
          actorId: schema.auditLog.actorId,
          action: schema.auditLog.action,
          target: schema.auditLog.target,
          data: schema.auditLog.data,
          createdAt: schema.auditLog.createdAt,
        })
        .from(schema.auditLog)
        .where(
          or(
            eq(schema.auditLog.teamId, team.id),
            // The instance's rows about the team, which its own audit never lists.
            and(isNull(schema.auditLog.teamId), eq(schema.auditLog.target, `team:${team.id}`)),
          ),
        )
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(20),
      teamMonitorOverview(ctx.db, team.id, monitorSettings, now),
      recentMonitorSamples(ctx.db, team.id, 20),
      ctx.db
        .select({
          id: g.id,
          reason: g.reason,
          scope: g.scope,
          emailIds: g.emailIds,
          createdAt: g.createdAt,
          expiresAt: g.expiresAt,
          viewCount: g.viewCount,
        })
        .from(g)
        .where(and(eq(g.teamId, team.id), sql`${g.expiresAt} > ${now}`))
        .orderBy(desc(g.createdAt)),
      teamWarmupOverview(ctx.db, team.id, now),
      listLimitRequests(ctx.db, { status: "open", teamId: team.id, limit: 500 }),
    ]);
    // The judge's answer for each flagged email, when it was drawn; the verdict fields only.
    const ms = schema.monitorSamples;
    const flaggedIds = flagged.map((row) => row.id);
    const verdicts = new Map(
      flaggedIds.length === 0
        ? []
        : (
            await ctx.db
              .select({
                emailId: ms.emailId,
                status: ms.status,
                score: ms.score,
                reasons: ms.reasons,
                errorClass: ms.errorClass,
              })
              .from(ms)
              .where(and(eq(ms.teamId, team.id), inArray(ms.emailId, flaggedIds)))
          ).map((row) => [row.emailId, row]),
    );
    // The tail names the people behind user actors, as the audit screens do.
    const actorIds = [
      ...new Set(
        audit.flatMap((row) => {
          const actor = parseAuditActor(row.actorId);
          return actor.kind === "user" ? [actor.id] : [];
        }),
      ),
    ];
    const actorNames = new Map(
      actorIds.length > 0
        ? (
            await ctx.db
              .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
              .from(schema.user)
              .where(inArray(schema.user.id, actorIds))
          ).map((u) => [u.id, u.name || u.email])
        : [],
    );
    return {
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        logoUrl: team.logoUrl,
        plan: team.plan as string,
        planQuota: team.planQuota,
        createdAt: team.createdAt,
        suspendedAt: team.suspendedAt,
        suspensionReason: team.suspensionReason,
        broadcastsPausedByOperatorAt: team.broadcastsPausedByOperatorAt,
        region: region.region,
        domains: region.domains,
        contacts,
        owners,
      },
      flag: flags.find((x) => x.status === "open") ?? flags[0] ?? null,
      flags,
      standing: {
        guardrail: health.status,
        reasons: health.reasons,
        scoreTenths: score.scoreTenths,
        complaintRate7d: health.complaintRate,
        hardBounceRate7d: health.bounceRate,
        sent7d: health.sent,
        complaintSent7d: health.complaintSent,
      },
      checks: factors.map((factor) => ({
        id: factor.id,
        severity: factor.severity,
        emails: factor.emails,
        recipients: factor.recipients,
      })),
      flaggedEmails: flagged.map((row) => {
        const failing = (row.checks as { id: string; severity: string; status: string }[]).filter(
          (c) => c.status === "fail" && (CRITICAL_OR_MAJOR as string[]).includes(c.id),
        );
        const verdict = verdicts.get(row.id);
        return {
          id: row.id,
          sentAt: row.sentAt,
          from: row.from,
          recipients: row.recipients,
          broadcastId: row.broadcastId,
          check: failing[0] ? { id: failing[0].id, severity: failing[0].severity } : null,
          failingCount: failing.length,
          model: verdict
            ? {
                status: verdict.status,
                score: verdict.score,
                reasons: verdict.reasons ?? [],
                errorClass: verdict.errorClass,
              }
            : null,
        };
      }),
      contentReveal: contentRevealOn(),
      grants,
      monitor: {
        ...monitor,
        samples,
        judge,
        flagScore: monitorSettings.flagScore,
        flagRisk: monitorSettings.flagRisk,
        alertRisk: monitorSettings.alertRisk,
      },
      warmup: {
        enabled: monitorSettings.warmupEnabled,
        ...warmup,
        domains: warmup.domains.map((domain) => ({
          ...domain,
          request: requests.find((request) => request.domainId === domain.id) ?? null,
        })),
      },
      audit: audit.map((row) => {
        const actor = parseAuditActor(row.actorId);
        return {
          ...row,
          actor,
          actorName: actor.kind === "user" ? (actorNames.get(actor.id) ?? null) : null,
        };
      }),
    };
  }),

  /**
   * Every email of a team, newest first, paginated, for the review page's
   * "All emails" list. Metadata only (sender, when, recipient count): the
   * subject is withheld and the body stays encrypted until a grant names the
   * message.
   */
  teamEmails: operatorProcedure
    .input(
      z.object({
        teamId: z.uuid(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: cursorSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const e = schema.emails;
      const ofTeam = eq(e.teamId, input.teamId);
      const recipients = emailRecipientsSql();
      const [rows, [count]] = await Promise.all([
        ctx.db
          .select({
            id: e.id,
            from: e.from,
            recipients,
            sentAt: e.sentAt,
            createdAt: e.createdAt,
            cursorCreatedAt: createdAtCursorField(e),
          })
          .from(e)
          .where(and(ofTeam, input.cursor ? beforeCursor(e, input.cursor) : undefined))
          .orderBy(desc(e.createdAt), desc(e.id))
          .limit(input.limit + 1),
        // Counted for the first page only: a scroll costs one count, not one per page.
        input.cursor
          ? [null]
          : ctx.db.select({ total: sql<number>`count(*)::int` }).from(e).where(ofTeam),
      ]);
      return { ...paginate(rows, input.limit), total: count?.total ?? null };
    }),

  /**
   * The warm-up override: a trusted team, or one trusted domain of it, sends
   * at its plan's volume from day one, and a trust grants the open limit
   * requests it covers. The audit row is the instance's, as the owner's own
   * log never shows trust & safety levers.
   */
  setWarmupTrust: operatorProcedure
    .input(z.object({ teamId: z.uuid(), domainId: z.uuid().optional(), trusted: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const set = await setWarmupTrust(ctx.db, {
        teamId: team.id,
        domainId: input.domainId,
        trusted: input.trusted,
        operator: ctx.operator.email,
      });
      if (!set) throw new TRPCError({ code: "NOT_FOUND" });
      await auditOperator(ctx, {
        teamId: null,
        action: input.trusted ? "warmup.trust_granted" : "warmup.trust_revoked",
        target: { type: "team", id: team.id },
        metadata: { team: team.name, ...(set.domain ? { domain: set.domain } : {}) },
      });
      // Mail the warm-up held goes out now rather than at the next drain.
      if (input.trusted) await kickQuotaDrain();
      return { trusted: input.trusted };
    }),

  /**
   * The open requests to lift a new domain's limit, newest first, with what
   * the limit holds on each domain now. Each is answered on its team's page.
   */
  limitRequests: operatorProcedure.query(async ({ ctx }) => {
    const requests = await listLimitRequests(ctx.db, { status: "open", limit: 100 });
    if (requests.length === 0) return [];
    const e = schema.emails;
    const teamIds = [...new Set(requests.map((request) => request.teamId))];
    const [held, logos] = await Promise.all([
      ctx.db
        .select({ domainId: e.domainId, n: sql<number>`count(*)::int` })
        .from(e)
        .where(
          and(
            inArray(e.teamId, teamIds),
            inArray(
              e.domainId,
              requests.map((request) => request.domainId),
            ),
            heldByNewDomainLimit(),
          ),
        )
        .groupBy(e.domainId),
      ctx.db.select({ id: t.id, logoUrl: t.logoUrl }).from(t).where(inArray(t.id, teamIds)),
    ]);
    return requests.map((request) => ({
      ...request,
      logoUrl: logos.find((row) => row.id === request.teamId)?.logoUrl ?? null,
      waiting: held.find((row) => row.domainId === request.domainId)?.n ?? 0,
    }));
  }),

  /**
   * Declines an open limit request: the domain keeps the new domain limit
   * and the notifications sweep tells the team. The audit row is the
   * instance's, as a trust's is.
   */
  declineLimitRequest: operatorProcedure
    .input(z.object({ requestId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const declined = await declineLimitRequest(ctx.db, {
        requestId: input.requestId,
        operator: ctx.operator.email,
      });
      if (!declined.ok) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "not_open" });
      }
      const d = schema.domains;
      const [names] = await ctx.db
        .select({ team: t.name, domain: d.name })
        .from(d)
        .innerJoin(t, eq(t.id, d.teamId))
        .where(eq(d.id, declined.request.domainId));
      await auditOperator(ctx, {
        teamId: null,
        action: "warmup.request_declined",
        target: { type: "team", id: declined.request.teamId },
        metadata: { team: names?.team, domain: names?.domain },
      });
      return { declined: true };
    }),

  /**
   * Break-glass: a time-boxed grant to read the subject and rendered text of
   * a team's messages, for a named security reason. Scope "email" names any
   * one message of the team, flagged or not; "flagged_window" covers the
   * review page's flagged set. Nothing decrypts here — the grant row and its
   * operator audit exist before any content can be asked for.
   */
  requestAccess: operatorProcedure
    .input(
      z
        .object({
          teamId: z.uuid(),
          reason: z.enum(CONTENT_REVEAL_REASONS),
          justification: z
            .string()
            .trim()
            .min(CONTENT_REVEAL_JUSTIFICATION_MIN)
            .max(CONTENT_REVEAL_JUSTIFICATION_MAX),
          scope: z.enum(CONTENT_REVEAL_SCOPES),
          /** Required for scope "email"; ignored for a whole-window grant. */
          emailId: z.uuid().optional(),
        })
        .refine((input) => input.scope !== "email" || input.emailId !== undefined, {
          message: "emailId is required for scope email",
          path: ["emailId"],
        })
        .refine(
          (input) =>
            input.scope === "email" || !CONTENT_REVEAL_ONE_MESSAGE_REASONS.includes(input.reason),
          { message: "this reason reads one named message", path: ["scope"] },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      assertContentRevealOn();
      const team = await loadTeam(ctx.db, input.teamId);
      const now = new Date();
      // Scope "email" names any one message of the team; "flagged_window" the
      // flagged set. Either way a grant only ever names ids that belong here.
      let candidateIds: string[];
      if (input.scope === "email") {
        const emailId = input.emailId;
        if (!emailId) throw new TRPCError({ code: "BAD_REQUEST" });
        const [email] = await ctx.db
          .select({ id: schema.emails.id })
          .from(schema.emails)
          .where(and(eq(schema.emails.id, emailId), eq(schema.emails.teamId, team.id)));
        if (!email) throw new TRPCError({ code: "NOT_FOUND", message: "not_found" });
        candidateIds = [email.id];
      } else {
        const flagged = await flaggedEmails(
          ctx.db,
          team.id,
          flaggedSince(now),
          (await monitorSettingsNow(ctx.db)).holdRepeatScore,
        );
        if (flagged.length === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "not_flagged" });
        }
        candidateIds = flagged.map((row) => row.id);
      }
      // A purged body cannot be revealed by anyone: retention already took it.
      const bodies = await ctx.db
        .select({ id: schema.emails.id, purgedAt: schema.emails.bodyPurgedAt })
        .from(schema.emails)
        .where(inArray(schema.emails.id, candidateIds));
      const purged = new Set(bodies.filter((row) => row.purgedAt !== null).map((row) => row.id));
      const emailIds = candidateIds.filter((id) => !purged.has(id));
      const refused = [...purged].map((emailId) => ({ emailId, status: "purged" as const }));
      if (emailIds.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "purged" });
      }
      const [grant] = await ctx.db
        .insert(g)
        .values({
          teamId: team.id,
          operatorUserId: ctx.operator.id,
          reason: input.reason,
          justification: input.justification,
          scope: input.scope,
          emailIds,
          createdAt: now,
          expiresAt: contentRevealExpiry(now),
          // A withheld disclosure (see the column): an older build's job skips it.
          noticeSentAt: now,
        })
        .returning({ id: g.id, expiresAt: g.expiresAt });
      if (!grant) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // teamId null: the operator's own record, which the team's audit query
      // can never reach. The team is not notified of the access.
      await auditOperator(ctx, {
        teamId: null,
        action: "content.revealed",
        target: { type: "team", id: team.id },
        metadata: {
          grantId: grant.id,
          team: team.name,
          reason: input.reason,
          emails: emailIds.length,
          fields: CONTENT_REVEAL_FIELDS,
        },
      });
      return { grantId: grant.id, expiresAt: grant.expiresAt, emailIds, refused };
    }),

  /**
   * The only way content ever leaves the server: subject and rendered visible
   * text of one email of a live grant, redacted. Never the HTML, the
   * recipients, the headers or the attachments.
   */
  revealed: operatorProcedure
    .input(z.object({ grantId: z.uuid(), emailId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const { grant, email, now } = await grantedEmail(ctx, input);
      if (
        email.bodyPurgedAt ||
        !email.bodyCiphertext ||
        !email.bodyIv ||
        !email.bodyWrappedDek ||
        email.bodyKeyVersion === null
      ) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "purged" });
      }
      const body = await decryptEmailBody(
        {
          ciphertext: email.bodyCiphertext,
          iv: email.bodyIv,
          wrappedDek: email.bodyWrappedDek,
          keyVersion: email.bodyKeyVersion,
        },
        getKeyring(),
        { teamId: email.teamId, rowId: email.id },
      );
      const content = renderRevealedBody(body);
      // The subject goes through the same pass: a one-time code lives there as
      // often as in the body, and nothing is lost by reducing it.
      const subject = redactRevealedText(email.subject);
      const ms = schema.monitorSamples;
      const [verdict] = await ctx.db
        .select({
          status: ms.status,
          score: ms.score,
          reasons: ms.reasons,
          errorClass: ms.errorClass,
        })
        .from(ms)
        .where(eq(ms.emailId, email.id))
        .orderBy(desc(ms.createdAt))
        .limit(1);
      return {
        subject: subject.spans,
        spans: content.spans,
        redactions: content.redactions + subject.redactions,
        verdict: verdict ?? null,
        expiresAt: grant.expiresAt,
        viewCount: await countView(ctx, grant, now),
      };
    }),

  /**
   * What screening read from a held email's images and attachments, under a
   * live grant as its text is: redacted like the body, previews only as the
   * worker's re-encoded JPEGs, link domains with the age the screening cache
   * knows. Never the files themselves.
   */
  media: operatorProcedure
    .input(z.object({ grantId: z.uuid(), emailId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const { grant, email, now } = await grantedEmail(ctx, input);
      if (email.bodyPurgedAt) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "purged" });
      }
      if (!email.media) throw new TRPCError({ code: "NOT_FOUND", message: "no_media" });
      const team = await loadTeam(ctx.db, email.teamId);
      // A grant's first look at the media is its own instance audit row, written
      // before anything decrypts; the stamp records that this grant opened the media.
      const [first] = await ctx.db
        .update(g)
        .set({ mediaViewedAt: now })
        .where(and(eq(g.id, grant.id), isNull(g.mediaViewedAt)))
        .returning({ id: g.id });
      if (first) {
        await auditOperator(ctx, {
          teamId: null,
          action: "content.revealed",
          target: { type: "team", id: team.id },
          metadata: {
            grantId: grant.id,
            team: team.name,
            reason: grant.reason,
            emails: 1,
            fields: CONTENT_REVEAL_MEDIA_FIELDS,
          },
        });
      }
      const view = renderRevealedMedia(
        await openMediaReview(email.media, getKeyring(), { teamId: email.teamId, rowId: email.id }),
      );
      const la = schema.linkDomainAges;
      const domains = [...new Set(view.links.map((link) => link.domain).filter(Boolean))];
      const ages = new Map(
        domains.length === 0
          ? []
          : (
              await ctx.db
                .select({ domain: la.domain, registeredAt: la.registeredAt })
                .from(la)
                .where(inArray(la.domain, domains))
            ).map((row) => [row.domain, row.registeredAt]),
      );
      const sameMedia = await sameMediaParked(ctx.db, team.id, email.id);
      return {
        ...view,
        why: email.parkReason && waitingWhy(email.parkReason),
        links: view.links.map((link) => ({
          ...link,
          registeredAt: ages.get(link.domain) ?? null,
        })),
        sameMedia: sameMedia.length,
        asOf: now,
        releasable: team.suspendedAt === null,
        expiresAt: grant.expiresAt,
        viewCount: await countView(ctx, grant, now),
      };
    }),

  /** The review list, across teams or for one: what screening stopped before SES. */
  waiting: operatorProcedure
    .input(z.object({ teamId: z.uuid().optional() }))
    .query(async ({ ctx, input }) => {
      const groups = await waitingEmails(
        ctx.db,
        (await monitorSettingsNow(ctx.db)).holdRepeatScore,
        input.teamId,
      );
      const teamIds = groups.map((group) => group.team.id);
      // This operator's own live grants: a media panel opens under one without asking again.
      const grants =
        teamIds.length === 0
          ? []
          : await ctx.db
              .select({ id: g.id, emailIds: g.emailIds, expiresAt: g.expiresAt })
              .from(g)
              .where(
                and(
                  eq(g.operatorUserId, ctx.operator.id),
                  inArray(g.teamId, teamIds),
                  sql`${g.expiresAt} > now()`,
                ),
              );
      // A Release or Cancel of "all" takes only what was parked by now.
      return { groups, grants, contentReveal: contentRevealOn(), asOf: new Date() };
    }),

  /**
   * Release: the emails go out without being screened again: the ones
   * named, or every one parked by `parkedBefore`, the moment the list was
   * read (its `asOf`). A team held for review is released with its hold,
   * from its review page.
   */
  releaseWaiting: operatorProcedure
    .input(waitingPick)
    .mutation(async ({ ctx, input }) =>
      releaseEmails(
        ctx,
        await loadTeam(ctx.db, input.teamId),
        input.emailIds
          ? { emailIds: input.emailIds }
          : { parkedBefore: input.parkedBefore as Date },
      ),
    ),

  /**
   * Release every email of the team parked with the same media as this one
   * by `parkedBefore` (when the panel was read), so a held blast clears in
   * one step: the same release, the same audit row.
   */
  releaseSameMedia: operatorProcedure
    .input(z.object({ teamId: z.uuid(), emailId: z.uuid(), parkedBefore: z.date() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const emailIds = await sameMediaParked(ctx.db, team.id, input.emailId, input.parkedBefore);
      return releaseEmails(ctx, team, { emailIds });
    }),

  /** Cancel: the emails never go out: the ones named, or every one parked by `parkedBefore`. */
  cancelWaiting: operatorProcedure.input(waitingPick).mutation(async ({ ctx, input }) => {
    const team = await loadTeam(ctx.db, input.teamId);
    const canceled = await cancelWaitingEmails(ctx.db, {
      ...input,
      holdLine: (await monitorSettingsNow(ctx.db)).holdRepeatScore,
    });
    if (canceled > 0) {
      await auditOperator(ctx, {
        teamId: null,
        action: "screening.canceled",
        target: { type: "team", id: team.id },
        metadata: { team: team.name, emails: canceled },
      });
    }
    return { canceled };
  }),

  clearFlag: operatorProcedure
    /** `afterGrantId` marks the clear as the verdict of a content reveal. */
    .input(z.object({ flagId: z.uuid(), afterGrantId: z.uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      const [flag] = await ctx.db.select().from(f).where(eq(f.id, input.flagId));
      if (!flag) throw new TRPCError({ code: "NOT_FOUND" });
      if (flag.status !== "open") return;
      await ctx.db
        .update(f)
        .set({ status: "cleared", clearedAt: new Date(), clearedBy: ctx.operator.id })
        .where(and(eq(f.id, flag.id), eq(f.status, "open")));
      await auditOperator(ctx, {
        teamId: flag.teamId,
        action: "console.flag_cleared",
        target: { type: "team_flag", id: flag.id },
        metadata: {
          reason: flag.reason,
          ...(input.afterGrantId ? { grantId: input.afterGrantId, verdict: "false_positive" } : {}),
        },
      });
    }),

  /** Reopen as a manual flag: the cron never clears what an operator reopened. */
  reopenFlag: operatorProcedure
    .input(z.object({ flagId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [flag] = await ctx.db.select().from(f).where(eq(f.id, input.flagId));
      if (!flag) throw new TRPCError({ code: "NOT_FOUND" });
      const [open] = await ctx.db
        .select({ id: f.id })
        .from(f)
        .where(and(eq(f.teamId, flag.teamId), eq(f.status, "open")));
      if (open) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "already_open" });
      // Reopened, a suspension's flag is the operator's own call, which no
      // reinstatement clears.
      const { suspension: _, ...detail } = flag.detail ?? {};
      const [reopened] = await ctx.db
        .insert(f)
        .values({
          teamId: flag.teamId,
          reason: flag.reason,
          detail: flag.detail && detail,
          note: flag.note,
          openedBy: ctx.operator.id,
        })
        .returning({ id: f.id });
      await auditOperator(ctx, {
        teamId: flag.teamId,
        action: "console.flag_reopened",
        target: { type: "team_flag", id: reopened?.id ?? flag.id },
        metadata: { reason: flag.reason, from: flag.id },
      });
    }),

  openFlag: operatorProcedure
    .input(z.object({ teamId: z.uuid(), note: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.teamId);
      const [open] = await ctx.db
        .select({ id: f.id })
        .from(f)
        .where(and(eq(f.teamId, team.id), eq(f.status, "open")));
      if (open) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "already_open" });
      const [row] = await ctx.db
        .insert(f)
        .values({ teamId: team.id, reason: "manual", note: input.note, openedBy: ctx.operator.id })
        .returning({ id: f.id });
      await auditOperator(ctx, {
        teamId: team.id,
        action: "console.flag_opened",
        target: { type: "team_flag", id: row?.id ?? "" },
        metadata: { name: team.name, note: input.note },
      });
    }),

  /** Cleared flags of a team, for the audit tail on the review page. */
  history: operatorProcedure.input(z.object({ teamId: z.uuid() })).query(({ ctx, input }) =>
    ctx.db
      .select()
      .from(f)
      .where(and(eq(f.teamId, input.teamId), inArray(f.status, ["open", "cleared"])))
      .orderBy(desc(f.openedAt))
      .limit(20),
  ),
});
