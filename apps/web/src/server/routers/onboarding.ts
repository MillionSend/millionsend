import { accountMailDeliverable, env } from "@millionsend/config";
import { acceptEmail, SILENT_SUSPENSIONS } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { fetchQuotaRow } from "../billing";
import { getKeyring } from "../keyring";
import { buildOnboardingEmail, MAIL_LOCALES } from "../onboarding-mail";
import { suspensionLockError } from "../suspension-lock";
import { router, teamProcedure } from "../trpc";
import { verifyTurnstile } from "../turnstile";

export const onboardingRouter = router({
  /**
   * The onboarding "Send email" button: the one email ONBOARDING_EMAIL_FROM
   * ever carries for a team, our fixed template to an owner's inbox, through
   * the same accept pipeline as the API so the email shows in the list,
   * counts toward quota, and feeds the odometer. Once per team: every later
   * call answers { sent: false } and sends nothing.
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
      const [team] = await ctx.db
        .select({
          suspendedAt: schema.teams.suspendedAt,
          suspensionReason: schema.teams.suspensionReason,
          sentAt: schema.teams.onboardingEmailSentAt,
        })
        .from(schema.teams)
        .where(eq(schema.teams.id, ctx.teamId));
      if (team?.sentAt) return { sent: false as const };
      if (team?.suspendedAt) {
        if (SILENT_SUSPENSIONS.includes(team.suspensionReason ?? "")) {
          throw await suspensionLockError("unavailable");
        }
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "team suspended" });
      }
      // The signed-in owner, else the team's first. Verified only, where the
      // instance verifies: an unconfirmed address may be anyone's inbox.
      const tm = schema.teamMembers;
      const [owner] = await ctx.db
        .select({ email: schema.user.email })
        .from(tm)
        .innerJoin(schema.user, eq(schema.user.id, tm.userId))
        .where(
          and(
            eq(tm.teamId, ctx.teamId),
            eq(tm.role, "owner"),
            accountMailDeliverable() ? eq(schema.user.emailVerified, true) : undefined,
          ),
        )
        .orderBy(desc(sql`${tm.userId} = ${ctx.session.user.id}`), asc(tm.createdAt))
        .limit(1);
      if (!owner) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "no verified owner" });
      }
      const message = buildOnboardingEmail({
        locale: input.locale,
        dashboardUrl: env.APP_BASE_URL ? `${env.APP_BASE_URL}/emails` : null,
      });
      const billing = await fetchQuotaRow(ctx.db, ctx.teamId);
      // Absent in tests: the reconcile sweep re-enqueues accepted rows.
      const enqueueEmailSend = ctx.enqueueEmailSend ?? (async () => {});
      // The claim commits with the accept, so a refused accept leaves the
      // team free to try again and a concurrent press finds it taken.
      const accepted = await ctx.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(schema.teams)
          .set({ onboardingEmailSentAt: new Date() })
          .where(and(eq(schema.teams.id, ctx.teamId), isNull(schema.teams.onboardingEmailSentAt)))
          .returning({ id: schema.teams.id });
        if (!claimed) return null;
        const result = await acceptEmail(
          { db: ctx.db, keyring: getKeyring(), isCloud: env.IS_CLOUD, enqueueEmailSend },
          { teamId: ctx.teamId, billing, apiKeyId: null },
          {
            from,
            to: [owner.email],
            subject: message.subject,
            html: message.html,
            text: message.text,
            domainId: null,
          },
          { tx: tx as unknown as Db },
        );
        if (!result.ok) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.reason });
        }
        return result;
      });
      if (!accepted) return { sent: false as const };
      // After commit, as acceptEmail does for its own transaction: the
      // reconcile sweep re-enqueues an accepted email whose job was lost.
      if (!accepted.parked) {
        await enqueueEmailSend(accepted.id).catch((err) => {
          console.error("email.send enqueue failed; reconcile sweep will recover", err);
        });
      }
      return { sent: true as const, id: accepted.id, to: owner.email };
    }),
});
