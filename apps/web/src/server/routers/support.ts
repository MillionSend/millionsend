import { endSupportView, liveSupportViewOfOperator } from "@millionsend/core";
import { protectedProcedure, router } from "../trpc";

export const supportRouter = router({
  /**
   * The caller's own live view, for the banner to check it still holds: a
   * session can end from another tab or by expiry, and nothing else would
   * tell a tab already under the banner that its view is over.
   */
  current: protectedProcedure.query(async ({ ctx }) => {
    const live = await liveSupportViewOfOperator(ctx.db, ctx.session.user.id);
    return live ? { grantId: live.id, teamId: live.teamId, expiresAt: live.expiresAt } : null;
  }),

  /**
   * Ends the caller's live support view, whichever team it is on, and drops
   * the cookie. The one mutation the read-only guard lets through; a call
   * with nothing live still clears the cookie and answers ended: false.
   */
  end: protectedProcedure.mutation(async ({ ctx }) => {
    const live = await liveSupportViewOfOperator(ctx.db, ctx.session.user.id);
    ctx.setSupportViewCookie?.(null);
    if (!live) return { ended: false, teamId: null };
    await endSupportView(ctx.db, live, { by: "operator" });
    return { ended: true, teamId: live.teamId };
  }),
});
