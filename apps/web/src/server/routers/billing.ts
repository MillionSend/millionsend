import {
  type BillingStripe,
  createCheckoutSession,
  createPortalSession,
  hasLiveSubscription,
  PAID_PLANS,
} from "@millionsend/billing";
import { env } from "@millionsend/config";
import { PLAN_DAILY_LIMIT } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { getStripe } from "../billing";
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
      plan: schema.teams.plan,
      planStatus: schema.teams.planStatus,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
      stripeCustomerId: schema.teams.stripeCustomerId,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!team) throw new TRPCError({ code: "NOT_FOUND" });
  return team;
}

const billingPageUrl = () => `${resolveBaseUrl(env.APP_BASE_URL)}/settings/billing`;

export function createBillingRouter(deps: BillingDeps = { stripe: getStripe }) {
  return router({
    status: teamProcedure.query(async ({ ctx }) => {
      requireCloud();
      const team = await loadTeam(ctx.db, ctx.teamId);
      return {
        plan: team.plan,
        planStatus: team.planStatus,
        currentPeriodEnd: team.currentPeriodEnd,
        dailyLimit: PLAN_DAILY_LIMIT[team.plan],
        hasCustomer: team.stripeCustomerId !== null,
        canCheckout: !hasLiveSubscription(team.planStatus),
      };
    }),

    checkout: adminProcedure
      .input(z.object({ plan: z.enum(PAID_PLANS) }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        // Plan changes on a live subscription go through the portal; a second
        // Checkout would create a second subscription.
        if (hasLiveSubscription(team.planStatus)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED" });
        }
        const url = await createCheckoutSession(
          { db: ctx.db, stripe: deps.stripe() },
          {
            team,
            plan: input.plan,
            email: ctx.session.user.email,
            successUrl: `${billingPageUrl()}?checkout=success`,
            cancelUrl: billingPageUrl(),
          },
        );
        await recordAudit(ctx, {
          action: "billing.checkout_started",
          target: { type: "team", id: ctx.teamId },
          metadata: { plan: input.plan },
        });
        return { url };
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
