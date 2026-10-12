import {
  generateApiKey,
  INBOX_KEYS_MAX,
  MAX_ACTIVE_API_KEYS,
  recordInboxActivity,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { userActor } from "../inboxes";
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
        inboxId: schema.apiKeys.inboxId,
        // Null unless the key reads and sends from one inbox only.
        inboxAddress: schema.inboxes.emailAddress,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .leftJoin(schema.domains, eq(schema.apiKeys.domainId, schema.domains.id))
      .leftJoin(schema.inboxes, eq(schema.apiKeys.inboxId, schema.inboxes.id))
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
        // A uuid restricts the key to one inbox: it reads and sends from that inbox only.
        inboxId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const k = schema.apiKeys;
      if (input.inboxId) {
        if (input.permission !== "full_access" || input.domainId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An inbox key needs full access and no domain",
          });
        }
        const [inbox] = await ctx.db
          .select({ id: schema.inboxes.id })
          .from(schema.inboxes)
          .where(and(eq(schema.inboxes.id, input.inboxId), eq(schema.inboxes.teamId, ctx.teamId)));
        if (!inbox) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "inboxId must be an inbox of this team",
          });
        }
      }
      // Inbox keys have their own cap per inbox, outside the team's.
      const [active] = await ctx.db
        .select({ n: count() })
        .from(k)
        .where(
          and(
            eq(k.teamId, ctx.teamId),
            isNull(k.revokedAt),
            input.inboxId ? eq(k.inboxId, input.inboxId) : isNull(k.inboxId),
          ),
        );
      const cap = input.inboxId ? INBOX_KEYS_MAX : MAX_ACTIVE_API_KEYS;
      if ((active?.n ?? 0) >= cap) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: input.inboxId
            ? `An inbox can have at most ${INBOX_KEYS_MAX} active API keys; revoke one first.`
            : `A team can have at most ${MAX_ACTIVE_API_KEYS} active API keys; revoke one first.`,
        });
      }
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
          inboxId: input.inboxId ?? null,
        })
        .returning({ id: schema.apiKeys.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.inboxId) {
        await recordInboxActivity(ctx.db, {
          teamId: ctx.teamId,
          inboxId: input.inboxId,
          actor: userActor(ctx),
          action: "key.created",
        });
      }
      await recordAudit(ctx, {
        action: "api_key.created",
        target: { type: "api_key", id: row.id },
        metadata: {
          name: input.name.trim(),
          permission: input.permission,
          domainId: input.domainId ?? null,
          inboxId: input.inboxId ?? null,
        },
      });
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
      .returning({ id: schema.apiKeys.id, inboxId: schema.apiKeys.inboxId });
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    if (row.inboxId) {
      await recordInboxActivity(ctx.db, {
        teamId: ctx.teamId,
        inboxId: row.inboxId,
        actor: userActor(ctx),
        action: "key.revoked",
      });
    }
    await recordAudit(ctx, { action: "api_key.revoked", target: { type: "api_key", id: row.id } });
    return { id: row.id };
  }),

  rename: adminProcedure
    .input(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(schema.apiKeys)
        .set({ name: input.name })
        .where(
          and(
            eq(schema.apiKeys.id, input.id),
            eq(schema.apiKeys.teamId, ctx.teamId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .returning({ id: schema.apiKeys.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await recordAudit(ctx, {
        action: "api_key.renamed",
        target: { type: "api_key", id: row.id },
        metadata: { name: input.name },
      });
      return { id: row.id, name: input.name };
    }),
});
