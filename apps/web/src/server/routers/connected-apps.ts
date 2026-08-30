import { ALL_TEAMS_GRANT } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, exists, or } from "drizzle-orm";
import { z } from "zod";
import { listMemberships } from "../membership";
import { router, teamProcedure } from "../trpc";

/**
 * A grant visible from the active team: bound to it directly, or an
 * all-teams grant whose holder is a member here. The membership check keeps
 * one user's all-teams grants out of teams they don't belong to.
 */
function grantVisibleFromTeam(db: Db, teamId: string) {
  return or(
    eq(schema.oauthConsent.referenceId, teamId),
    and(
      eq(schema.oauthConsent.referenceId, ALL_TEAMS_GRANT),
      exists(
        db
          .select({ one: schema.teamMembers.userId })
          .from(schema.teamMembers)
          .where(
            and(
              eq(schema.teamMembers.teamId, teamId),
              eq(schema.teamMembers.userId, schema.oauthConsent.userId),
            ),
          ),
      ),
    ),
  );
}

/**
 * OAuth grants (MCP clients) bound to the active team, plus all-teams grants
 * held by its members. A grant is one (client, user, team-or-all) consent
 * row; revoking it deletes the consent and the refresh tokens behind it, so
 * the client is back to the consent screen at its next refresh.
 * Already-issued access tokens are JWTs the API verifies offline and expire
 * on their own (accessTokenExpiresIn).
 */
export const connectedAppsRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: schema.oauthConsent.id,
        clientId: schema.oauthConsent.clientId,
        clientName: schema.oauthClient.name,
        clientUri: schema.oauthClient.uri,
        userId: schema.oauthConsent.userId,
        userEmail: schema.user.email,
        scopes: schema.oauthConsent.scopes,
        referenceId: schema.oauthConsent.referenceId,
        grantedAt: schema.oauthConsent.createdAt,
      })
      .from(schema.oauthConsent)
      .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
      .leftJoin(schema.user, eq(schema.user.id, schema.oauthConsent.userId))
      .where(grantVisibleFromTeam(ctx.db, ctx.teamId))
      .orderBy(desc(schema.oauthConsent.createdAt));
    return rows.map(({ referenceId, ...row }) => ({
      ...row,
      own: row.userId === ctx.session.user.id,
      allTeams: referenceId === ALL_TEAMS_GRANT,
    }));
  }),

  // Members revoke their own grants; owners/admins can cut off anyone's —
  // except an all-teams grant, which only someone who administers every team
  // the holder belongs to may revoke, since revoking it cuts the client off
  // in teams outside this admin's reach.
  revoke: teamProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [consent] = await ctx.db
        .select({
          id: schema.oauthConsent.id,
          clientId: schema.oauthConsent.clientId,
          userId: schema.oauthConsent.userId,
          referenceId: schema.oauthConsent.referenceId,
        })
        .from(schema.oauthConsent)
        .where(and(eq(schema.oauthConsent.id, input.id), grantVisibleFromTeam(ctx.db, ctx.teamId)));
      if (!consent) throw new TRPCError({ code: "NOT_FOUND" });
      if (consent.userId !== ctx.session.user.id) {
        if (ctx.role === "member") throw new TRPCError({ code: "FORBIDDEN" });
        if (consent.referenceId === ALL_TEAMS_GRANT && consent.userId) {
          const [holderTeams, adminTeams] = await Promise.all([
            listMemberships(ctx.db, consent.userId),
            listMemberships(ctx.db, ctx.session.user.id),
          ]);
          const administered = new Set(
            adminTeams.filter((m) => m.role !== "member").map((m) => m.teamId),
          );
          if (holderTeams.some((m) => !administered.has(m.teamId))) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "This grant also covers teams you do not administer. Only its holder can revoke it.",
            });
          }
        }
      }
      await ctx.db.transaction(async (tx) => {
        // Tokens carry the grant's own referenceId — ctx.teamId for a
        // team-bound grant, ALL_TEAMS_GRANT for an all-teams one (revoking
        // that cuts the client off everywhere, which is the safe direction).
        const tokenScope = (
          table: typeof schema.oauthRefreshToken | typeof schema.oauthAccessToken,
        ) =>
          and(
            eq(table.clientId, consent.clientId),
            eq(table.userId, consent.userId ?? ""),
            eq(table.referenceId, consent.referenceId ?? ctx.teamId),
          );
        await tx.delete(schema.oauthAccessToken).where(tokenScope(schema.oauthAccessToken));
        await tx.delete(schema.oauthRefreshToken).where(tokenScope(schema.oauthRefreshToken));
        await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.id, consent.id));
      });
      return { id: consent.id };
    }),
});
