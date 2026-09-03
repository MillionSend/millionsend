import { env } from "@millionsend/config";
import { acceptEmail, fetchEffectivePlan } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getKeyring } from "../keyring";
import { buildOnboardingEmail, MAIL_LOCALES } from "../onboarding-mail";
import { router, teamProcedure } from "../trpc";

export const onboardingRouter = router({
  /**
   * The onboarding "Send email" button: ONBOARDING_EMAIL_FROM to the signed-in
   * member's own inbox, through the same accept pipeline as the API so the
   * email shows in the list, counts toward quota, and feeds the odometer.
   */
  sendFirstEmail: teamProcedure
    .input(z.object({ locale: z.enum(MAIL_LOCALES) }))
    .mutation(async ({ ctx, input }) => {
      const from = env.ONBOARDING_EMAIL_FROM;
      if (!from) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "ONBOARDING_EMAIL_FROM is not configured",
        });
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
