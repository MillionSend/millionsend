import { generateApiKey } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { adminProcedure, router, teamProcedure } from "../trpc";

export const apiKeysRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        tokenPrefix: schema.apiKeys.tokenPrefix,
        last4: schema.apiKeys.last4,
        permission: schema.apiKeys.permission,
        domainId: schema.apiKeys.domainId,
        // Null when the key is not domain-scoped (any verified domain).
        domainName: schema.domains.name,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .leftJoin(schema.domains, eq(schema.apiKeys.domainId, schema.domains.id))
      .where(and(eq(schema.apiKeys.teamId, ctx.teamId), isNull(schema.apiKeys.revokedAt)))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows;
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        permission: z.enum(schema.apiKeyPermissionEnum.enumValues).default("full_access"),
        // Null/omitted = any verified domain; a uuid scopes the key to one domain.
        domainId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.domainId) {
        // The scope is enforced server-side, but a key can only be scoped to a
        // domain the team actually owns and has verified — reject anything else.
        const [domain] = await ctx.db
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(
            and(
              eq(schema.domains.id, input.domainId),
              eq(schema.domains.teamId, ctx.teamId),
              eq(schema.domains.status, "verified"),
            ),
          );
        if (!domain) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "domainId must be a verified domain of this team",
          });
        }
      }
      const generated = generateApiKey();
      const [row] = await ctx.db
        .insert(schema.apiKeys)
        .values({
          teamId: ctx.teamId,
          name: input.name.trim(),
          tokenPrefix: generated.tokenPrefix,
          keyHash: generated.keyHash,
          last4: generated.last4,
          permission: input.permission,
          domainId: input.domainId ?? null,
        })
        .returning({ id: schema.apiKeys.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // The full secret exists only in this response — the row stores
      // tokenPrefix + hash + last4, and no other code path returns or logs it.
      return { id: row.id, token: generated.token };
    }),

  // Soft revoke: the row is kept so tokenPrefix lookups keep resolving (and
  // failing verification) instead of dangling, and last-used history survives.
  revoke: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
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
