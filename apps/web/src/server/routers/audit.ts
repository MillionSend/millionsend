import { parseAuditActor, SILENT_SUSPENSIONS } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

/**
 * Read-only, and never a member feed: the trail is a forensic record. A
 * support view reads it too — it is metadata, it carries that session's own
 * two rows, and answering "when did this change" is what support is for.
 */
export const auditRouter = router({
  list: teamProcedure
    .input(
      z.object({
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (ctx.role === "member") throw new TRPCError({ code: "FORBIDDEN" });
      const t = schema.auditLog;
      const rows = await ctx.db
        .select({
          id: t.id,
          actorId: t.actorId,
          action: t.action,
          target: t.target,
          data: t.data,
          createdAt: t.createdAt,
          cursorCreatedAt: createdAtCursorField(t),
        })
        .from(t)
        .where(
          and(eq(t.teamId, ctx.teamId), input.cursor ? beforeCursor(t, input.cursor) : undefined),
        )
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(input.limit + 1);
      const page = paginate(rows, input.limit);

      // Resolve user actors to a name in one query; a deleted user keeps its id.
      const actors = page.items.map((row) => parseAuditActor(row.actorId));
      const userIds = [...new Set(actors.flatMap((a) => (a.kind === "user" ? [a.id] : [])))];
      const users =
        userIds.length > 0
          ? await ctx.db
              .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
              .from(schema.user)
              .where(inArray(schema.user.id, userIds))
          : [];
      const byId = new Map(users.map((u) => [u.id, u]));

      return {
        nextCursor: page.nextCursor,
        items: page.items.map(({ actorId: _actorId, ...row }, i) => {
          const actor = actors[i] ?? { kind: "system" as const };
          const user = actor.kind === "user" ? byId.get(actor.id) : undefined;
          return {
            ...row,
            // The operator's note on a silent suspension says what was seen,
            // and the team must not learn from it what got it caught.
            data:
              row.action === "team.suspended" &&
              SILENT_SUSPENSIONS.includes(String(row.data?.reason))
                ? { ...row.data, note: null }
                : row.data,
            actor: {
              ...actor,
              ...(user ? { name: user.name, email: user.email } : {}),
            },
          };
        }),
      };
    }),
});
