import { env } from "@millionsend/config";
import { acceptEmail, fetchEffectivePlan } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getKeyring } from "../keyring";
import { buildOnboardingEmail, MAIL_LOCALES } from "../onboarding-mail";
import { router, teamProcedure } from "../trpc";
import { verifyTurnstile } from "../turnstile";

/** Onboarding sends per team: enough to retry, too few to be worth abusing. */
export const ONBOARDING_SEND_LIMITS = [
  { windowMs: 60 * 60 * 1000, max: 5 },
  { windowMs: 24 * 60 * 60 * 1000, max: 20 },
] as const;

export const onboardingRouter = router({
  /**
   * The onboarding "Send email" button: ONBOARDING_EMAIL_FROM to the signed-in
   * member's own inbox, through the same accept pipeline as the API so the
   * email shows in the list, counts toward quota, and feeds the odometer.
   */
  sendFirstEmail: teamProcedure
    .input(z.object({ locale: z.enum(MAIL_LOCALES), captchaToken: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const from = env.ONBOARDING_EMAIL_FROM;
      if (!from) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "ONBOARDING_EMAIL_FROM is not configured",
        });
      }
      if (!(await verifyTurnstile(input.captchaToken))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "captcha" });
      }
      // The shared sender carries the platform's reputation: cap what one
      // team can push through it, counted from the rows the sends leave.
      const t = schema.emails;
      for (const { windowMs, max } of ONBOARDING_SEND_LIMITS) {
        const [row] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(t)
          .where(
            and(
              eq(t.teamId, ctx.teamId),
              isNull(t.domainId),
              eq(t.from, from),
              gt(t.createdAt, new Date(Date.now() - windowMs)),
            ),
          );
        if ((row?.n ?? 0) >= max) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "onboarding send limit" });
        }
      }
      const [team] = await ctx.db
        .select({ name: schema.teams.name })
        .from(schema.teams)
        .where(eq(schema.teams.id, ctx.teamId));
      const message = buildOnboardingEmail({
        locale: input.locale,
        team: team?.name ?? "",
        dashboardUrl: env.APP_BASE_URL ? `${env.APP_BASE_URL}/emails` : null,
      });
      const result = await acceptEmail(
        {
          db: ctx.db,
          keyring: getKeyring(),
          isCloud: env.IS_CLOUD,
          // Absent in tests: the reconcile sweep re-enqueues accepted rows.
          enqueueEmailSend: ctx.enqueueEmailSend ?? (async () => {}),
        },
        {
          teamId: ctx.teamId,
          plan: (await fetchEffectivePlan(ctx.db, ctx.teamId)) ?? "free",
          apiKeyId: null,
        },
        {
          from,
          to: [ctx.session.user.email],
          subject: message.subject,
          html: message.html,
          text: message.text,
          domainId: null,
        },
      );
      if (!result.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.reason });
      return { id: result.id };
    }),
});
