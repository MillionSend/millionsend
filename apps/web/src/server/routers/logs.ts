import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

const STATUS_CLASS_RANGE = {
  "2xx": [200, 300],
  "4xx": [400, 500],
  "5xx": [500, 600],
} as const;

/** Read-only surface over api_requests; rows are written by the API middleware. */
export const logsRouter = router({
  list: teamProcedure
    .input(
      z.object({
        statusClass: z.enum(["2xx", "4xx", "5xx"]).optional(),
        search: z.string().trim().max(200).optional(),
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
        // MCP callers authenticate without a key, so api_key_id is null for them.
        source: z.enum(["api_key", "mcp"]).optional(),
        since: z.coerce.date().optional(),
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const t = schema.apiRequests;
      const filters: (SQL | undefined)[] = [eq(t.teamId, ctx.teamId)];
      if (input.statusClass) {
        const [lo, hi] = STATUS_CLASS_RANGE[input.statusClass];
        filters.push(gte(t.statusCode, lo), lt(t.statusCode, hi));
      }
      if (input.search) filters.push(ilike(t.path, `%${escapeLike(input.search)}%`));
      if (input.method) filters.push(eq(t.method, input.method));
      if (input.source)
        filters.push(input.source === "mcp" ? isNull(t.apiKeyId) : isNotNull(t.apiKeyId));
      if (input.since) filters.push(gte(t.createdAt, input.since));
      if (input.cursor) filters.push(beforeCursor(t, input.cursor));
      const rows = await ctx.db
        .select({
          id: t.id,
          method: t.method,
          path: t.path,
          statusCode: t.statusCode,
          createdAt: t.createdAt,
          cursorCreatedAt: createdAtCursorField(t),
        })
        .from(t)
        .where(and(...filters))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(input.limit + 1);
      return paginate(rows, input.limit);
    }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const t = schema.apiRequests;
    const [row] = await ctx.db
      .select()
      .from(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    // Bodies carry recipient data and full API payloads: admin-only, while
    // the metadata stays readable for every member.
    if (ctx.role === "member") return { ...row, requestBody: null, responseBody: null };
    return row;
  }),
});
