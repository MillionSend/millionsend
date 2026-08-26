import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { router, teamProcedure } from "../trpc";

/**
 * OAuth grants (MCP clients) bound to the active team. A grant is one
 * (client, user, team) consent row; revoking it deletes the consent and the
 * refresh tokens behind it, so the client is back to the consent screen at
 * its next refresh. Already-issued access tokens are JWTs the API verifies
 * offline and expire on their own (accessTokenExpiresIn).
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
        grantedAt: schema.oauthConsent.createdAt,
      })
      .from(schema.oauthConsent)
      .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
      .leftJoin(schema.user, eq(schema.user.id, schema.oauthConsent.userId))
      .where(eq(schema.oauthConsent.referenceId, ctx.teamId))
      .orderBy(desc(schema.oauthConsent.createdAt));
    return rows.map((row) => ({ ...row, own: row.userId === ctx.session.user.id }));
  }),

  // Members revoke their own grants; owners/admins can cut off anyone's.
  revoke: teamProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [consent] = await ctx.db
        .select({
          id: schema.oauthConsent.id,
          clientId: schema.oauthConsent.clientId,
          userId: schema.oauthConsent.userId,
        })
        .from(schema.oauthConsent)
        .where(
          and(
            eq(schema.oauthConsent.id, input.id),
            eq(schema.oauthConsent.referenceId, ctx.teamId),
          ),
        );
      if (!consent) throw new TRPCError({ code: "NOT_FOUND" });
      if (consent.userId !== ctx.session.user.id && ctx.role === "member") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      await ctx.db.transaction(async (tx) => {
        const tokenScope = (
          table: typeof schema.oauthRefreshToken | typeof schema.oauthAccessToken,
        ) =>
          and(
            eq(table.clientId, consent.clientId),
            eq(table.userId, consent.userId ?? ""),
            eq(table.referenceId, ctx.teamId),
          );
        await tx.delete(schema.oauthAccessToken).where(tokenScope(schema.oauthAccessToken));
        await tx.delete(schema.oauthRefreshToken).where(tokenScope(schema.oauthRefreshToken));
        await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.id, consent.id));
      });
      return { id: consent.id };
    }),
});
