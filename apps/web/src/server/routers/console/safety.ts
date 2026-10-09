import { contentRevealOn, env } from "@millionsend/config";
import {
  CHECKS,
  CONTENT_REVEAL_FIELDS,
  CONTENT_REVEAL_JUSTIFICATION_MAX,
  CONTENT_REVEAL_JUSTIFICATION_MIN,
  CONTENT_REVEAL_ONE_MESSAGE_REASONS,
  CONTENT_REVEAL_REASONS,
  CONTENT_REVEAL_SCOPES,
  contentRevealExpiry,
  decryptEmailBody,
  fetchAccountScore,
  fetchContentFactors,
  fetchDeliverabilityHealth,
  getMonitorSettingsRow,
  parseAuditActor,
  recentMonitorSamples,
  redactRevealedText,
  renderRevealedBody,
  resolveMonitorSettings,
  TEAM_FLAG_REASONS,
  teamMonitorOverview,
} from "@millionsend/core";
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
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { judgeStatus } from "../../console/monitor";
import { getKeyring } from "../../keyring";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, loadTeam } from "./shared";

const f = schema.teamFlags;
const t = schema.teams;
const st = schema.teamStandings;
const teamRegion = sql<
  string | null
>`(select d.region from ${schema.domains} d where d.team_id = ${t}."id" order by d.verified_at desc nulls last, d.created_at desc limit 1)`;

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
 * The flagged emails of a team's window: one row per email, a broadcast's
 * recipients sharing its insights row. The review page lists these and a
 * grant may only ever name ids from here.
 */
function flaggedEmails(db: Db, teamId: string, since: Date) {
  const e = schema.emails;
  const i = schema.emailInsights;
  return db
    .select({
      id: e.id,
      sentAt: e.sentAt,
      from: e.from,
      recipients: sql<number>`jsonb_array_length(${e.to})`,
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
}

/** Every content procedure refuses the same way while the feature is off. */
function assertContentRevealOn(): void {
  if (!contentRevealOn()) throw new TRPCError({ code: "FORBIDDEN", message: "off" });
}

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
            broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
            scoreTenths: st.scoreTenths,
            guardrail: st.guardrail,
            complaintRate7d: st.complaintRate7d,
            hardBounceRate7d: st.hardBounceRate7d,
            sent7d: st.sent7d,
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
      flaggedEmails(ctx.db, team.id, since),
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
   * Break-glass: a time-boxed grant to read the subject and rendered text of
   * flagged messages, for a named security reason. Nothing decrypts here —
   * the grant row and its audit exist before any content can be asked for.
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
      const flagged = await flaggedEmails(ctx.db, team.id, flaggedSince(now));
      const wanted =
        input.scope === "email" ? flagged.filter((row) => row.id === input.emailId) : flagged;
      if (wanted.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "not_flagged" });
      // A purged body cannot be revealed by anyone: retention already took it.
      const bodies = await ctx.db
        .select({ id: schema.emails.id, purgedAt: schema.emails.bodyPurgedAt })
        .from(schema.emails)
        .where(
          inArray(
            schema.emails.id,
            wanted.map((row) => row.id),
          ),
        );
      const purged = new Set(bodies.filter((row) => row.purgedAt !== null).map((row) => row.id));
      const emailIds = wanted.map((row) => row.id).filter((id) => !purged.has(id));
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
        })
        .returning({ id: g.id, expiresAt: g.expiresAt });
      if (!grant) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // teamId null: the instance's own row, which the team's audit query
      // can never reach. Its own row arrives seven days later, from the cron.
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
      assertContentRevealOn();
      const [grant] = await ctx.db.select().from(g).where(eq(g.id, input.grantId));
      // Someone else's grant reads as no grant at all.
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
      const [counted] = await ctx.db
        .update(g)
        .set({ viewCount: sql`${g.viewCount} + 1`, lastViewedAt: now })
        .where(eq(g.id, grant.id))
        .returning({ viewCount: g.viewCount });
      return {
        subject: subject.spans,
        spans: content.spans,
        redactions: content.redactions + subject.redactions,
        verdict: verdict ?? null,
        expiresAt: grant.expiresAt,
        viewCount: counted?.viewCount ?? grant.viewCount + 1,
      };
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
