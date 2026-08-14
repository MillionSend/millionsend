import { generateApiKey } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { router, teamProcedure } from "../trpc";

/** There is no mode column; the mode is encoded in the token scheme prefix. */
function modeFromPrefix(tokenPrefix: string): "live" | "test" {
  return tokenPrefix.startsWith("ms_test_") ? "test" : "live";
}

export const apiKeysRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        tokenPrefix: schema.apiKeys.tokenPrefix,
        last4: schema.apiKeys.last4,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.teamId, ctx.teamId), isNull(schema.apiKeys.revokedAt)))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows.map((row) => ({ ...row, mode: modeFromPrefix(row.tokenPrefix) }));
  }),

  create: teamProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        mode: z.enum(["live", "test"]).default("live"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const generated = generateApiKey(input.mode);
      const [row] = await ctx.db
        .insert(schema.apiKeys)
        .values({
          teamId: ctx.teamId,
          name: input.name.trim(),
          tokenPrefix: generated.tokenPrefix,
          keyHash: generated.keyHash,
          last4: generated.last4,
        })
        .returning({ id: schema.apiKeys.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // The full secret exists only in this response — the row stores
      // tokenPrefix + hash + last4, and no other code path returns or logs it.
      return { id: row.id, token: generated.token };
    }),

  // Soft revoke: the row is kept so tokenPrefix lookups keep resolving (and
  // failing verification) instead of dangling, and last-used history survives.
  revoke: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, input.id),
          eq(schema.apiKeys.teamId, ctx.teamId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning({ id: schema.apiKeys.id });
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return { id: row.id };
  }),
});
