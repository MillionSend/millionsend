import {
  type BillingStripe,
  changeRung,
  createCheckoutSession,
  createPortalSession,
  hasLiveSubscription,
  setOverage as setSubscriptionOverage,
} from "@millionsend/billing";
import { env } from "@millionsend/config";
import {
  PLAN_RUNG_KEYS,
  QUOTA_COLUMNS,
  raisesQuota,
  readPeriodUsage,
  rungByKey,
  type TeamQuota,
  teamQuota,
  teamRung,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { getStripe, mailPlanMove } from "../billing";
import { getQueue } from "../queue";
import { adminProcedure, router, teamProcedure } from "../trpc";

/** Stripe seam for tests, mirroring SystemSesDeps. */
export interface BillingDeps {
  stripe(): BillingStripe;
}

// Billing does not exist on self-host: not forbidden, absent.
function requireCloud(): void {
  if (!env.IS_CLOUD) throw new TRPCError({ code: "NOT_FOUND" });
}

async function loadTeam(db: Db, teamId: string) {
  const [team] = await db
    .select({
      id: schema.teams.id,
      name: schema.teams.name,
      ...QUOTA_COLUMNS,
      planStatus: schema.teams.planStatus,
      stripeCustomerId: schema.teams.stripeCustomerId,
      cancelAt: schema.teams.cancelAt,
      pendingRung: schema.teams.pendingRung,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!team) throw new TRPCError({ code: "NOT_FOUND" });
  return team;
}

/** Sends counted against the quota so far: the UTC day on a daily cap, the billing period on a monthly one. */
async function readUsage(db: Db, teamId: string, quota: TeamQuota) {
  if (quota.kind === "month") return readPeriodUsage(db, teamId, quota.periodStart);
  const c = schema.usageCounters;
  const [row] = await db
    .select({ accepted: c.accepted })
    .from(c)
    .where(and(eq(c.teamId, teamId), eq(c.day, utcDay())));
  return { accepted: row?.accepted ?? 0, reportedOverage: 0 };
}

/** Rungs for sale; Free is reached by cancelling in the portal. */
const paidRung = z.enum(PLAN_RUNG_KEYS).refine((key) => rungByKey(key).priceCents > 0);

/**
 * Mail parked over the old cap would otherwise wait for the next scheduled
 * drain. Best-effort: the plan is already committed, and the scheduled
 * drain releases the mail regardless.
 */
async function kickQuotaDrain(): Promise<void> {
  try {
    await (await getQueue()).runCronNow("quota.drain");
  } catch (err) {
    console.error(
      "billing: quota.drain kick failed; the scheduled drain will release the mail",
      err,
    );
  }
}

const billingPageUrl = () => `${resolveBaseUrl(env.APP_BASE_URL)}/settings/billing`;

export function createBillingRouter(deps: BillingDeps = { stripe: getStripe }) {
  return router({
    status: teamProcedure.query(async ({ ctx }) => {
      requireCloud();
      const team = await loadTeam(ctx.db, ctx.teamId);
      const quota = teamQuota(team, true);
      const live = hasLiveSubscription(team.planStatus);
      return {
        plan: team.plan,
        planQuota: team.planQuota,
        rung: teamRung(team.plan, team.planQuota).key,
        pendingRung: team.pendingRung,
        planStatus: team.planStatus,
        currentPeriodEnd: team.currentPeriodEnd,
        quota,
        usage: await readUsage(ctx.db, ctx.teamId, quota),
        hasCustomer: team.stripeCustomerId !== null,
        hasLiveSubscription: live,
      };
    }),

    checkout: adminProcedure
      .input(z.object({ rung: paidRung }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        // Plan changes on a live subscription go through changePlan; a second
        // Checkout would create a second subscription.
        if (hasLiveSubscription(team.planStatus)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED" });
        }
        const url = await createCheckoutSession(
          { db: ctx.db, stripe: deps.stripe() },
          {
            team,
            rung: input.rung,
            email: ctx.session.user.email,
            successUrl: `${billingPageUrl()}?checkout=success`,
            cancelUrl: billingPageUrl(),
          },
        );
        await recordAudit(ctx, {
          action: "billing.checkout_started",
          target: { type: "team", id: ctx.teamId },
          metadata: { rung: input.rung },
        });
        return { url };
      }),

    /**
     * Moves a live subscription to another rung with Stripe prorations. The
     * portal cannot switch plans on a subscription carrying a metered item,
     * so every plan change happens here.
     */
    changePlan: adminProcedure
      .input(z.object({ rung: paidRung }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        if (!hasLiveSubscription(team.planStatus)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED" });
        }
        const change = await changeRung(
          { db: ctx.db, stripe: deps.stripe() },
          { teamId: ctx.teamId, rung: input.rung },
        );
        await recordAudit(ctx, {
          action: "billing.plan_changed",
          target: { type: "team", id: ctx.teamId },
          metadata: { rung: input.rung, applied: change.applied },
        });
        const after = await loadTeam(ctx.db, ctx.teamId);
        if (raisesQuota(teamQuota(team, true), teamQuota(after, true))) await kickQuotaDrain();
        // The row already moved, so the webhook that follows sees no move; the
        // owners hear it from here. Best-effort: the plan change is committed.
        try {
          await mailPlanMove(ctx.db, { id: team.id, name: team.name }, team, after);
        } catch (err) {
          console.error("billing: plan change mail skipped", err);
        }
        return change;
      }),

    setOverage: adminProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        if (
          !hasLiveSubscription(team.planStatus) ||
          teamRung(team.plan, team.planQuota).period !== "month"
        ) {
          throw new TRPCError({ code: "PRECONDITION_FAILED" });
        }
        await setSubscriptionOverage(
          { db: ctx.db, stripe: deps.stripe() },
          { teamId: ctx.teamId, enabled: input.enabled },
        );
        await recordAudit(ctx, {
          action: "billing.overage_toggled",
          target: { type: "team", id: ctx.teamId },
          metadata: { enabled: input.enabled },
        });
        if (input.enabled) await kickQuotaDrain();
        return { enabled: input.enabled };
      }),

    portal: adminProcedure.mutation(async ({ ctx }) => {
      requireCloud();
      const team = await loadTeam(ctx.db, ctx.teamId);
      if (!team.stripeCustomerId) throw new TRPCError({ code: "PRECONDITION_FAILED" });
      const url = await createPortalSession(deps.stripe(), {
        customerId: team.stripeCustomerId,
        returnUrl: billingPageUrl(),
        configuration: env.STRIPE_PORTAL_CONFIG,
      });
      await recordAudit(ctx, {
        action: "billing.portal_opened",
        target: { type: "team", id: ctx.teamId },
      });
      return { url };
    }),
  });
}

export const billingRouter = createBillingRouter();
