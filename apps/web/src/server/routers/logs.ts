import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { parseLogSource } from "@/lib/log-source";
import { escapeLike } from "@/lib/sql";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

const STATUS_CLASS_RANGE = {
  "2xx": [200, 300],
  "4xx": [400, 500],
  "5xx": [500, 600],
} as const;

/** "api_key" | "mcp" | "api_key:<uuid>" | "mcp:<client id>", parsed; see parseLogSource. */
const logSourceInput = z
  .string()
  .max(300)
  .transform((value, ctx) => {
    const source = parseLogSource(value);
    if (!source) {
      ctx.addIssue({ code: "custom", message: "Invalid source filter" });
      return z.NEVER;
    }
    return source;
  });

/** Read-only surface over api_requests; rows are written by the API middleware. */
export const logsRouter = router({
  list: teamProcedure
    .input(
      z.object({
        statusClass: z.enum(["2xx", "4xx", "5xx"]).optional(),
        search: z.string().trim().max(200).optional(),
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
        source: logSourceInput.optional(),
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
      // MCP callers authenticate without a key, so api_key_id is null for them.
      if (input.source?.kind === "api_key") {
        filters.push(
          input.source.callerId ? eq(t.apiKeyId, input.source.callerId) : isNotNull(t.apiKeyId),
        );
      } else if (input.source?.kind === "mcp") {
        filters.push(
          input.source.callerId ? eq(t.oauthClientId, input.source.callerId) : isNull(t.apiKeyId),
        );
      }
      if (input.since) filters.push(gte(t.createdAt, input.since));
      if (input.cursor) filters.push(beforeCursor(t, input.cursor));
      const rows = await ctx.db
        .select({
          id: t.id,
          method: t.method,
          path: t.path,
          statusCode: t.statusCode,
          apiKeyId: t.apiKeyId,
          oauthClientId: t.oauthClientId,
          createdAt: t.createdAt,
          cursorCreatedAt: createdAtCursorField(t),
        })
        .from(t)
        .where(and(...filters))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(input.limit + 1);
      return paginate(rows, input.limit);
    }),

  /**
   * Who can appear as a caller in this team's log: every API key (revoked
   * ones too — their rows outlive them) and each OAuth client seen in the
   * log, with the connected app's name when the client is still registered.
   */
  callers: teamProcedure.query(async ({ ctx }) => {
    const k = schema.apiKeys;
    const apiKeys = await ctx.db
      .select({
        id: k.id,
        name: k.name,
        tokenPrefix: k.tokenPrefix,
        last4: k.last4,
        revoked: sql<boolean>`${k.revokedAt} is not null`,
      })
      .from(k)
      .where(eq(k.teamId, ctx.teamId))
      .orderBy(isNotNull(k.revokedAt), asc(k.name));
    const t = schema.apiRequests;
    const c = schema.oauthClient;
    const apps = await ctx.db
      .selectDistinct({ clientId: sql<string>`${t.oauthClientId}`, name: c.name })
      .from(t)
      .leftJoin(c, eq(c.clientId, t.oauthClientId))
      .where(and(eq(t.teamId, ctx.teamId), isNotNull(t.oauthClientId)))
      .orderBy(asc(c.name));
    return { apiKeys, apps };
  }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const t = schema.apiRequests;
    const [row] = await ctx.db
      .select()
      .from(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    let apiKeyName: string | null = null;
    let apiKeyRevoked = false;
    let oauthClientName: string | null = null;
    if (row.apiKeyId) {
      const k = schema.apiKeys;
      const [key] = await ctx.db
        .select({ name: k.name, revokedAt: k.revokedAt })
        .from(k)
        .where(and(eq(k.id, row.apiKeyId), eq(k.teamId, ctx.teamId)))
        .limit(1);
      apiKeyName = key?.name ?? null;
      apiKeyRevoked = key?.revokedAt != null;
    } else if (row.oauthClientId) {
      const c = schema.oauthClient;
      const [app] = await ctx.db
        .select({ name: c.name })
        .from(c)
        .where(eq(c.clientId, row.oauthClientId))
        .limit(1);
      oauthClientName = app?.name ?? null;
    }
    const caller = { apiKeyName, apiKeyRevoked, oauthClientName };

    // Bodies carry recipient data and full API payloads: admin-only, while
    // the metadata stays readable for every member.
    if (ctx.role === "member") return { ...row, ...caller, requestBody: null, responseBody: null };
    return { ...row, ...caller };
  }),
});
