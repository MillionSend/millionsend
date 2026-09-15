import { isCloudDeployment } from "@millionsend/config";
import {
  accountMailPhrase,
  fetchAccountScore,
  fetchDeliverabilityHealth,
  PLAN_RUNGS,
  type Plan,
  raisesQuota,
  SUSPENSION_REASONS,
  teamQuota,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { getQueue } from "../../queue";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, loadTeam, mailTeamOwners } from "./shared";

const SORT_KEYS = [
  "name",
  "type",
  "domains",
  "contacts",
  "sent30d",
  "score",
  "guardrail",
  "created",
] as const;
const PAUSE_REASONS = ["complaints", "report", "manual"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const t = schema.teams;
const st = schema.teamStandings;

// Correlated subqueries the list and the detail share; each is an index range on the team id.
const ownerEmail = sql<
  string | null
>`(select u.email from ${schema.teamMembers} m join ${schema.user} u on u.id = m.user_id where m.team_id = ${t}."id" and m.role = 'owner' order by m.created_at limit 1)`;
const memberCount = sql<number>`(select count(*)::int from ${schema.teamMembers} m where m.team_id = ${t}."id")`;
const domainCount = sql<number>`(select count(*)::int from ${schema.domains} d where d.team_id = ${t}."id" and d.status = 'verified')`;
const contactCount = sql<number>`(select count(*)::int from ${schema.contacts} c where c.team_id = ${t}."id")`;
// The team's region is that of its most recently verified domain, the breaker's own convention.
const teamRegion = sql<
  string | null
>`(select d.region from ${schema.domains} d where d.team_id = ${t}."id" order by d.verified_at desc nulls last, d.created_at desc limit 1)`;
const planRank = sql<number>`case ${t.plan}::text when 'free' then 0 when 'starter' then 1 when 'pro' then 2 when 'scale' then 3 else 4 end`;
const guardrailRank = sql<number>`case ${st.guardrail} when 'warning' then 1 when 'paused' then 2 else 0 end`;

const SORT_EXPR: Record<(typeof SORT_KEYS)[number], SQL | AnyPgColumn> = {
  name: t.name,
  type: planRank,
  domains: domainCount,
  contacts: contactCount,
  sent30d: sql`${st.sent30d}`,
  score: sql`${st.scoreTenths}`,
  guardrail: guardrailRank,
  created: t.createdAt,
};

/** The columns every row and the detail carry. */
const ROW = {
  id: t.id,
  name: t.name,
  slug: t.slug,
  logoUrl: t.logoUrl,
  plan: sql<string>`${t.plan}::text`,
  planQuota: t.planQuota,
  ownerEmail,
  members: memberCount,
  domains: domainCount,
  contacts: contactCount,
  region: teamRegion,
  createdAt: t.createdAt,
  suspendedAt: t.suspendedAt,
  suspensionReason: t.suspensionReason,
  suspensionNote: t.suspensionNote,
  broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
  dailySendCeiling: t.dailySendCeiling,
  stripeCustomerId: t.stripeCustomerId,
  stripeSubscriptionId: t.stripeSubscriptionId,
  planStatus: t.planStatus,
  scoreTenths: st.scoreTenths,
  guardrail: st.guardrail,
  sent30d: st.sent30d,
  standingAt: st.computedAt,
};

/** Search by anything an operator has in hand: names, ids, member and owner emails, domains, Stripe ids. */
function searchWhere(q: string): SQL | undefined {
  const like = `%${escapeLike(q)}%`;
  return or(
    ilike(t.name, like),
    ilike(t.slug, like),
    UUID.test(q) ? eq(t.id, q) : undefined,
    eq(t.stripeCustomerId, q),
    eq(t.stripeSubscriptionId, q),
    sql`exists (select 1 from ${schema.teamMembers} m join ${schema.user} u on u.id = m.user_id where m.team_id = ${t}."id" and u.email ilike ${like})`,
    sql`exists (select 1 from ${schema.domains} d where d.team_id = ${t}."id" and d.name ilike ${like})`,
  );
}

const planValues = schema.planEnum.enumValues as readonly string[];

/** The rungs an operator may put a team on: every plan rung, plus system when the enum carries it. */
export function operatorRungs(): { plan: string; planQuota: number | null; key: string }[] {
  const rungs = PLAN_RUNGS.map((r) => ({
    plan: r.plan,
    planQuota: r.period === "month" ? r.included : null,
    key: r.key,
  }));
  return planValues.includes("system")
    ? [...rungs, { plan: "system", planQuota: null, key: "system" }]
    : rungs;
}

/** What a pause or suspension mail says in the reason slot: the phrase, then the operator's note. */
function reasonText(
  locale: Parameters<typeof accountMailPhrase>[0]["locale"],
  kind: "team.broadcasts_paused" | "team.suspended",
  reason: string,
  note: string | undefined,
): string {
  const phrase = accountMailPhrase({ locale, kind, key: reason });
  return note
    ? `${phrase} ${accountMailPhrase({ locale, kind, key: "note", values: { note } })}`
    : phrase;
}

export const consoleTeamsRouter = router({
  list: operatorProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        type: z.string().max(32).optional(),
        region: z.string().max(32).optional(),
        guardrail: z.enum(["ok", "warning", "paused"]).optional(),
        sort: z.enum(SORT_KEYS).default("sent30d"),
        dir: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters: (SQL | undefined)[] = [];
      if (input.search) filters.push(searchWhere(input.search));
      if (input.type) filters.push(sql`${t.plan}::text = ${input.type}`);
      if (input.region) filters.push(sql`${teamRegion} = ${input.region}`);
      if (input.guardrail) {
        filters.push(
          input.guardrail === "ok"
            ? or(eq(st.guardrail, "ok"), isNull(st.guardrail))
            : eq(st.guardrail, input.guardrail),
        );
      }
      const where = filters.length > 0 ? and(...filters) : undefined;
      const expr = SORT_EXPR[input.sort];
      const order =
        input.dir === "asc" ? sql`${expr} asc nulls last` : sql`${expr} desc nulls last`;
      const [rows, [count]] = await Promise.all([
        ctx.db
          .select(ROW)
          .from(t)
          .leftJoin(st, eq(st.teamId, t.id))
          .where(where)
          .orderBy(order, asc(t.id))
          .limit(input.limit + 1)
          .offset(input.offset),
        ctx.db
          .select({ total: sql<number>`count(*)::int` })
          .from(t)
          .leftJoin(st, eq(st.teamId, t.id))
          .where(where),
      ]);
      const items = rows.slice(0, input.limit);
      return {
        items,
        total: count?.total ?? 0,
        nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
        rungs: operatorRungs(),
      };
    }),

  /** One team, the way the console's team dialog and the review page read it: counters live, standing fresh. */
  detail: operatorProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select(ROW)
      .from(t)
      .leftJoin(st, eq(st.teamId, t.id))
      .where(eq(t.id, input.id));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    const [owners, health, score] = await Promise.all([
      ctx.db
        .select({ email: schema.user.email, name: schema.user.name, role: schema.teamMembers.role })
        .from(schema.teamMembers)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, input.id))
        .orderBy(asc(schema.teamMembers.createdAt)),
      fetchDeliverabilityHealth(ctx.db, input.id),
      fetchAccountScore(ctx.db, input.id),
    ]);
    return {
      ...row,
      members: owners,
      guardrail: health.status,
      scoreTenths: score.scoreTenths,
      complaintRate7d: health.complaintRate,
      hardBounceRate7d: health.bounceRate,
      sent7d: health.sent,
      cloud: isCloudDeployment(),
      rungs: operatorRungs(),
    };
  }),

  /** Write the plan directly; never for a team Stripe manages, and never touching Stripe. */
  changePlan: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        plan: z.string().max(32),
        planQuota: z.number().int().positive().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      // A live subscription owns the plan; an ended one (canceled, never
      // completed) leaves the row to the operator.
      if (
        team.stripeSubscriptionId &&
        !["none", "canceled", "incomplete"].includes(team.planStatus)
      ) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "managed_by_stripe" });
      }
      const rung = operatorRungs().find(
        (r) => r.plan === input.plan && r.planQuota === input.planQuota,
      );
      if (!rung) throw new TRPCError({ code: "BAD_REQUEST", message: "unknown_rung" });
      const before = { plan: team.plan as string, planQuota: team.planQuota };
      if (before.plan === rung.plan && before.planQuota === rung.planQuota) return;
      await ctx.db
        .update(t)
        .set({ plan: rung.plan as Plan, planQuota: rung.planQuota })
        .where(eq(t.id, team.id));
      const typeChange = before.plan === "system" || rung.plan === "system";
      await auditOperator(ctx, {
        teamId: team.id,
        action: typeChange ? "team.type_changed" : "billing.plan_changed",
        target: { type: "team", id: team.id },
        metadata: {
          from: before,
          to: { plan: rung.plan, planQuota: rung.planQuota },
          name: team.name,
        },
      });
      const cloud = isCloudDeployment();
      if (
        raisesQuota(
          teamQuota(team, cloud),
          teamQuota({ ...team, plan: rung.plan as Plan, planQuota: rung.planQuota }, cloud),
        )
      ) {
        await kickQuotaDrain();
      }
    }),

  /** The daily ceiling beside the plan, and the broadcast switch. */
  adjustLimits: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        dailySendCeiling: z.number().int().min(1).max(100_000_000).nullable(),
        broadcastsPaused: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      const now = new Date();
      const pausedBefore = team.broadcastsPausedByOperatorAt !== null;
      await ctx.db
        .update(t)
        .set({
          dailySendCeiling: input.dailySendCeiling,
          broadcastsPausedByOperatorAt: input.broadcastsPaused
            ? (team.broadcastsPausedByOperatorAt ?? now)
            : null,
        })
        .where(eq(t.id, team.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.limits_updated",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          dailySendCeiling: input.dailySendCeiling,
          broadcastsPaused: input.broadcastsPaused,
        },
      });
      if (pausedBefore !== input.broadcastsPaused) {
        await auditOperator(ctx, {
          teamId: team.id,
          action: input.broadcastsPaused ? "team.broadcasts_paused" : "team.broadcasts_resumed",
          target: { type: "team", id: team.id },
          metadata: { name: team.name, reason: "manual" },
        });
        if (input.broadcastsPaused) {
          await mailTeamOwners(ctx.db, team, "team.broadcasts_paused", "/broadcasts", (locale) => ({
            reason: reasonText(locale, "team.broadcasts_paused", "manual", undefined),
          }));
        }
      }
      const cloud = isCloudDeployment();
      // A lifted ceiling frees parked rows even when the month's capacity
      // reads the same, so the ceiling is compared on its own.
      const lifted =
        (input.dailySendCeiling ?? Number.POSITIVE_INFINITY) >
        (team.dailySendCeiling ?? Number.POSITIVE_INFINITY);
      if (
        lifted ||
        (pausedBefore && !input.broadcastsPaused) ||
        raisesQuota(
          teamQuota(team, cloud),
          teamQuota({ ...team, dailySendCeiling: input.dailySendCeiling }, cloud),
        )
      ) {
        await kickQuotaDrain();
      }
    }),

  pauseBroadcasts: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.enum(PAUSE_REASONS),
        note: z.string().trim().max(1000).optional(),
        notify: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      if (team.broadcastsPausedByOperatorAt) return;
      await ctx.db
        .update(t)
        .set({ broadcastsPausedByOperatorAt: new Date() })
        .where(eq(t.id, team.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.broadcasts_paused",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          reason: input.reason,
          note: input.note ?? null,
          notified: input.notify,
        },
      });
      if (input.notify) {
        await mailTeamOwners(ctx.db, team, "team.broadcasts_paused", "/broadcasts", (locale) => ({
          reason: reasonText(locale, "team.broadcasts_paused", input.reason, input.note),
        }));
      }
    }),

  resumeBroadcasts: operatorProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      if (!team.broadcastsPausedByOperatorAt) return;
      await ctx.db.update(t).set({ broadcastsPausedByOperatorAt: null }).where(eq(t.id, team.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.broadcasts_resumed",
        target: { type: "team", id: team.id },
        metadata: { name: team.name },
      });
      await kickQuotaDrain();
    }),

  /** Every send refused until reinstated; owners hear about it unless it is phishing. */
  suspend: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.enum(SUSPENSION_REASONS),
        note: z.string().trim().max(1000).optional(),
        notify: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      await ctx.db
        .update(t)
        .set({
          suspendedAt: team.suspendedAt ?? new Date(),
          suspensionReason: input.reason,
          suspensionNote: input.note ?? null,
        })
        .where(eq(t.id, team.id));
      const notify = input.notify && input.reason !== "phishing";
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.suspended",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          reason: input.reason,
          note: input.note ?? null,
          notified: notify,
        },
      });
      if (notify) {
        await mailTeamOwners(ctx.db, team, "team.suspended", "/emails", (locale) => ({
          reason: reasonText(locale, "team.suspended", input.reason, input.note),
        }));
      }
      // The trust & safety list is the register of suspended teams, so a
      // suspension without a flag opens a manual one.
      await ctx.db
        .insert(schema.teamFlags)
        .values({
          teamId: team.id,
          reason: "manual",
          note: input.note ?? null,
          openedBy: ctx.operator.id,
        })
        .onConflictDoNothing();
    }),

  reinstate: operatorProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      await ctx.db
        .update(t)
        .set({ suspendedAt: null, suspensionReason: null, suspensionNote: null })
        .where(eq(t.id, team.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.reinstated",
        target: { type: "team", id: team.id },
        metadata: { name: team.name, reason: team.suspensionReason },
      });
      if (team.suspendedAt && team.suspensionReason !== "phishing") {
        await mailTeamOwners(ctx.db, team, "team.reinstated", "/emails", () => ({}));
      }
      await kickQuotaDrain();
    }),
});

/** Sends parked under the old ceiling would otherwise wait for the scheduled drain. Best-effort. */
async function kickQuotaDrain(): Promise<void> {
  try {
    await (await getQueue()).runCronNow("quota.drain");
  } catch (err) {
    console.error("console: quota.drain kick failed; the scheduled drain releases the mail", err);
  }
}
