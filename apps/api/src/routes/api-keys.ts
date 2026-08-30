import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { generateApiKey, MAX_ACTIVE_API_KEYS } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { type Env, errorBody, keysetPage } from "../app.js";
import {
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  errorSchema,
  listApiKeysResponseSchema,
  listQuerySchema,
  removeApiKeyResponseSchema,
} from "../schemas.js";

export function registerApiKeyRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const k = schema.apiKeys;

  app.openapi(
    createRoute({
      method: "post",
      path: "/api-keys",
      request: {
        body: { content: { "application/json": { schema: createApiKeyRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: createApiKeyResponseSchema } },
          description: "API key created; the token is returned only here",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const [active] = await db
        .select({ n: count() })
        .from(k)
        .where(and(eq(k.teamId, auth.teamId), isNull(k.revokedAt)));
      if ((active?.n ?? 0) >= MAX_ACTIVE_API_KEYS) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            `A team can have at most ${MAX_ACTIVE_API_KEYS} active API keys; revoke one first`,
          ),
          422,
        );
      }
      if (body.domain_id) {
        // The scope is enforced server-side, but a key can only be scoped to
        // a domain the team actually owns and has verified — reject anything
        // else (a foreign id gets the same answer as an unverified one).
        const [domain] = await db
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(
            and(
              eq(schema.domains.id, body.domain_id),
              eq(schema.domains.teamId, auth.teamId),
              eq(schema.domains.status, "verified"),
            ),
          );
        if (!domain) {
          return c.json(
            errorBody(422, "validation_error", "domain_id must be a verified domain of this team"),
            422,
          );
        }
      }
      const generated = generateApiKey();
      const [row] = await db
        .insert(k)
        .values({
          teamId: auth.teamId,
          name: body.name,
          tokenPrefix: generated.tokenPrefix,
          keyHash: generated.keyHash,
          last4: generated.last4,
          permission: body.permission,
          domainId: body.domain_id ?? null,
          createdByApiKeyId: auth.apiKeyId,
        })
        .returning({ id: k.id });
      if (!row) throw new Error("api key insert returned no row");
      // The full secret exists only in this response — the row stores
      // tokenPrefix + hash + last4, and the request logger redacts `token`.
      return c.json({ id: row.id, token: generated.token }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api-keys",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listApiKeysResponseSchema } },
          description: "API keys (never tokens)",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: k.createdAt,
        id: k.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: k.createdAt, id: k.id })
              .from(k)
              .where(and(eq(k.id, id), eq(k.teamId, auth.teamId), isNull(k.revokedAt)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(k)
            .where(and(eq(k.teamId, auth.teamId), isNull(k.revokedAt), cond))
            .orderBy(
              ...(descending ? [desc(k.createdAt), desc(k.id)] : [asc(k.createdAt), asc(k.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        {
          object: "list" as const,
          data: page.rows.map((row) => ({
            id: row.id,
            name: row.name,
            created_at: row.createdAt.toISOString(),
            last_used_at: row.lastUsedAt?.toISOString() ?? null,
          })),
          has_more: page.hasMore,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api-keys/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeApiKeyResponseSchema } },
          description: "API key revoked",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      // Soft revoke: the row is kept so tokenPrefix lookups keep resolving
      // (and failing verification) instead of dangling, and last-used history
      // survives. An already-revoked key is a 404, like the dashboard.
      const [row] = await db
        .update(k)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(k.id, c.req.valid("param").id), eq(k.teamId, auth.teamId), isNull(k.revokedAt)),
        )
        .returning({ id: k.id });
      if (!row) return c.json(errorBody(404, "not_found", "API key not found"), 404);
      return c.json({ object: "api_key" as const, id: row.id, deleted: true as const }, 200);
    },
  );
}
