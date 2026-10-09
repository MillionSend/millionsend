import { isLiveKey } from "@millionsend/billing";
import { env, isCloudDeployment, supportViewEnabled } from "@millionsend/config";
import {
  accountMailPhrase,
  fetchAccountScore,
  fetchDeliverabilityHealth,
  liveSupportViewForTeam,
  PLAN_RUNGS,
  type Plan,
  raisesQuota,
  SUPPORT_VIEW_REASONS,
  SUPPORT_VIEW_SIGN_IN_MINUTES,
  SUSPENSION_REASONS,
  startSupportView,
  teamQuota,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { escapeLike } from "@/lib/sql";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, kickQuotaDrain, loadTeam, mailTeamOwners } from "./shared";

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
        supportViewEnabled: supportViewEnabled(),
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
    const viewEnabled = supportViewEnabled();
    const [owners, health, score, view] = await Promise.all([
      ctx.db
        .select({ email: schema.user.email, name: schema.user.name, role: schema.teamMembers.role })
        .from(schema.teamMembers)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, input.id))
        .orderBy(asc(schema.teamMembers.createdAt)),
      fetchDeliverabilityHealth(ctx.db, input.id),
      fetchAccountScore(ctx.db, input.id),
      viewEnabled ? liveSupportViewForTeam(ctx.db, input.id) : null,
    ]);
    return {
      ...row,
      stripeSubscriptionUrl: row.stripeSubscriptionId
        ? `https://dashboard.stripe.com/${isLiveKey(env.STRIPE_SECRET_KEY ?? "") ? "" : "test/"}subscriptions/${row.stripeSubscriptionId}`
        : null,
      members: owners,
      guardrail: health.status,
      scoreTenths: score.scoreTenths,
      complaintRate7d: health.complaintRate,
      hardBounceRate7d: health.bounceRate,
      sent7d: health.sent,
      cloud: isCloudDeployment(),
      rungs: operatorRungs(),
      supportViewEnabled: viewEnabled,
      supportView: view ? { operatorEmail: view.operator.email, expiresAt: view.expiresAt } : null,
    };
  }),

  /**
   * Opens the team's dashboard as its owner sees it, read-only, for 30
   * minutes: a grant on the operator's own session (never a session for the
   * owner), named by a cookie the context re-checks on every request. No mail
   * goes out: the team's audit trail carries the start at once, written with
   * the grant, and the owner can end the view from Settings.
   */
  startSupportView: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.enum(SUPPORT_VIEW_REASONS),
        reference: z.string().trim().max(200).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!supportViewEnabled()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "support_view_off" });
      }
      // No nesting: a live view is left through its banner, not replaced from inside.
      if (ctx.supportView) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "support_view_live" });
      }
      const signedInAt = ctx.session.session?.createdAt;
      if (
        !signedInAt ||
        Date.now() - signedInAt.getTime() > SUPPORT_VIEW_SIGN_IN_MINUTES * 60_000
      ) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "sign_in_again" });
      }
      const team = await loadTeam(ctx.db, input.id);
      const [own] = await ctx.db
        .select({ id: schema.teamMembers.id })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, team.id),
            eq(schema.teamMembers.userId, ctx.operator.id),
          ),
        )
        .limit(1);
      if (own) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "own_team" });
      const reference = input.reference || null;
      // Every view answers a request the customer made, so it names that request.
      if (!reference) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "reference_required" });
      }
      let grant: Awaited<ReturnType<typeof startSupportView>>;
      try {
        grant = await startSupportView(ctx.db, {
          teamId: team.id,
          operatorUserId: ctx.operator.id,
          reason: input.reason,
          reference,
          note: input.note || null,
        });
      } catch (error) {
        // The one-live-view-per-operator index, tripped by two starts racing:
        // the other one won, so this reads as a view already being live.
        if (!isUniqueViolation(error)) throw error;
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "support_view_live" });
      }
      ctx.setSupportViewCookie?.({ id: grant.id, expiresAt: grant.expiresAt });
      return { grantId: grant.id, expiresAt: grant.expiresAt };
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
      if (!input.broadcastsPaused) {
        // Lifting the hold lifts the monitor's pause too, as Resume does.
        await ctx.db
          .update(schema.teamMonitor)
          .set({ broadcastsPausedAt: null, broadcastsResumedAt: now })
          .where(
            and(
              eq(schema.teamMonitor.teamId, team.id),
              isNotNull(schema.teamMonitor.broadcastsPausedAt),
            ),
          );
      }
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
        // A suspended team is not told: the notice says transactional mail
        // keeps flowing, which the suspension stops, and phishing stays silent.
        if (input.broadcastsPaused && !team.suspendedAt) {
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
      // Same rule as adjustLimits: a suspended team is not told.
      const notify = input.notify && !team.suspendedAt;
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.broadcasts_paused",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          reason: input.reason,
          note: input.note ?? null,
          notified: notify,
        },
      });
      if (notify) {
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
      // The monitor's pause rides on the same hold; lifting one lifts both.
      await ctx.db
        .update(schema.teamMonitor)
        .set({ broadcastsPausedAt: null, broadcastsResumedAt: new Date() })
        .where(
          and(
            eq(schema.teamMonitor.teamId, team.id),
            isNotNull(schema.teamMonitor.broadcastsPausedAt),
          ),
        );
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
