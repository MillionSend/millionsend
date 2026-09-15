import { AUDIT_ACTIONS, parseAuditActor } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../../keyset";
import { operatorProcedure, router } from "../../trpc";

/** Actions the instance audit lists whoever performed them; the operator's own rows are listed whatever the action. */
const CONSOLE_ACTION_PREFIXES = ["console.", "team.", "region.", "instance.", "guardrail."];

export const consoleAuditRouter = router({
  list: operatorProcedure
    .input(
      z.object({
        action: z.string().max(64).optional(),
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const a = schema.auditLog;
      const scope = or(
        eq(a.actorId, `user:${ctx.operator.id}`),
        ...CONSOLE_ACTION_PREFIXES.map((prefix) => like(a.action, `${prefix}%`)),
      );
      const rows = await ctx.db
        .select({
          id: a.id,
          teamId: a.teamId,
          teamName: schema.teams.name,
          actorId: a.actorId,
          action: a.action,
          target: a.target,
          data: a.data,
          ip: a.ip,
          createdAt: a.createdAt,
          cursorCreatedAt: createdAtCursorField(a),
        })
        .from(a)
        .leftJoin(schema.teams, eq(schema.teams.id, a.teamId))
        .where(
          and(
            scope,
            input.action ? eq(a.action, input.action) : undefined,
            input.cursor ? beforeCursor(a, input.cursor) : undefined,
          ),
        )
        .orderBy(desc(a.createdAt), desc(a.id))
        .limit(input.limit + 1);
      const page = paginate(rows, input.limit);
      const actors = page.items.map((row) => parseAuditActor(row.actorId));
      const userIds = [...new Set(actors.flatMap((x) => (x.kind === "user" ? [x.id] : [])))];
      const users =
        userIds.length > 0
          ? await ctx.db
              .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
              .from(schema.user)
              .where(inArray(schema.user.id, userIds))
          : [];
      const byId = new Map(users.map((u) => [u.id, u]));
      const [total] = input.cursor
        ? [null]
        : await ctx.db
            .select({ n: sql<number>`count(*)::int` })
            .from(a)
            .where(and(scope, input.action ? eq(a.action, input.action) : undefined));
      return {
        nextCursor: page.nextCursor,
        total: total?.n ?? null,
        actions: AUDIT_ACTIONS.filter((x) =>
          CONSOLE_ACTION_PREFIXES.some((prefix) => x.startsWith(prefix)),
        ),
        items: page.items.map(({ actorId: _actorId, ...row }, index) => {
          const actor = actors[index] ?? { kind: "system" as const };
          const user = actor.kind === "user" ? byId.get(actor.id) : undefined;
          return {
            ...row,
            actor: { ...actor, ...(user ? { name: user.name, email: user.email } : {}) },
          };
        }),
      };
    }),
});
