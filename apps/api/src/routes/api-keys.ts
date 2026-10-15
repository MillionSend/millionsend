import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  apiRequestActor,
  generateApiKey,
  getInboxSafety,
  INBOX_KEY_SCOPE_MESSAGE,
  INBOX_KEYS_MAX,
  inboxActorFromAuth,
  MAX_ACTIVE_API_KEYS,
  recordAudit,
  recordInboxActivity,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { type Env, errorBody, KEYSET_LIST_DESCRIPTION, keysetPage } from "../app.js";
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
        403: jsonErr(
          "Restricted API key: a sending_access key, an inbox-scoped key, or a domain_id outside the calling key's domain",
        ),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      // SECURITY: an inbox-scoped key never mints, whatever the route allow-list says.
      if (auth.inboxId) {
        return c.json(errorBody(403, "restricted_api_key", INBOX_KEY_SCOPE_MESSAGE), 403);
      }
      // SECURITY: a minted key is never broader than the key minting it. Under
      // a domain-scoped minter, an omitted or null domain_id inherits the
      // minter's domain and any other is refused; only a full_access minter
      // may pick another permission. Lowercased because a client may send an
      // uppercase uuid while Postgres returns them lowercase.
      const domainId = body.domain_id?.toLowerCase() ?? auth.domainId;
      if (auth.domainId !== null && domainId !== auth.domainId) {
        return c.json(
          errorBody(
            403,
            "restricted_api_key",
            "This API key can only create keys scoped to its own domain",
          ),
          403,
        );
      }
      if (auth.permission !== "full_access" && body.permission !== auth.permission) {
        return c.json(
          errorBody(
            403,
            "restricted_api_key",
            `This API key can only create ${auth.permission} keys`,
          ),
          403,
        );
      }
      const inboxId = body.inbox_id?.toLowerCase() ?? null;
      if (inboxId !== null) {
        if (auth.domainId !== null) {
          return c.json(
            errorBody(
              403,
              "restricted_api_key",
              "A domain-scoped API key can't create inbox-scoped keys",
            ),
            403,
          );
        }
        const refusal =
          body.permission !== "full_access"
            ? "An inbox-scoped key needs permission full_access"
            : domainId !== null
              ? "inbox_id can't be combined with domain_id"
              : (await getInboxSafety(db, { teamId: auth.teamId, inboxId })) === null
                ? "inbox_id must be an inbox of this team"
                : null;
        if (refusal) return c.json(errorBody(422, "validation_error", refusal), 422);
      }
      // Inbox-scoped keys have their own cap per inbox, outside the team's.
      const [active] = await db
        .select({ n: count() })
        .from(k)
        .where(
          and(
            eq(k.teamId, auth.teamId),
            isNull(k.revokedAt),
            inboxId === null ? isNull(k.inboxId) : eq(k.inboxId, inboxId),
          ),
        );
      const cap = inboxId === null ? MAX_ACTIVE_API_KEYS : INBOX_KEYS_MAX;
      if ((active?.n ?? 0) >= cap) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            inboxId === null
              ? `A team can have at most ${MAX_ACTIVE_API_KEYS} active API keys; revoke one first`
              : `An inbox can have at most ${INBOX_KEYS_MAX} active API keys; revoke one first`,
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
          domainId,
          inboxId,
          createdByApiKeyId: auth.apiKeyId,
        })
        .returning({ id: k.id });
      if (!row) throw new Error("api key insert returned no row");
      if (inboxId !== null) {
        await recordInboxActivity(db, {
          teamId: auth.teamId,
          inboxId,
          actor: inboxActorFromAuth(auth),
          action: "key.created",
        });
      }
      await recordAudit(db, {
        teamId: auth.teamId,
        actor: apiRequestActor(auth),
        action: "api_key.created",
        target: { type: "api_key", id: row.id },
        metadata: {
          name: body.name,
          permission: body.permission,
          domainId,
          inboxId,
        },
      });
      // The full secret exists only in this response — the row stores
      // tokenPrefix + hash + last4, and the request logger redacts `token`.
      return c.json({ id: row.id, token: generated.token }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api-keys",
      description: KEYSET_LIST_DESCRIPTION,
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
        loadRows: (cond, orderBy, take) =>
          db
            .select()
            .from(k)
            .where(and(eq(k.teamId, auth.teamId), isNull(k.revokedAt), cond))
            .orderBy(...orderBy)
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "invalid pagination cursor: after and before take the id of an item this list returned",
          ),
          422,
        );
      }
      return c.json(
        {
          object: "list" as const,
          data: page.rows.map((row) => ({
            id: row.id,
            name: row.name,
            created_at: row.createdAt.toISOString(),
            last_used_at: row.lastUsedAt?.toISOString() ?? null,
            inbox_id: row.inboxId,
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
        .returning({ id: k.id, inboxId: k.inboxId });
      if (!row) return c.json(errorBody(404, "not_found", "API key not found"), 404);
      if (row.inboxId !== null) {
        await recordInboxActivity(db, {
          teamId: auth.teamId,
          inboxId: row.inboxId,
          actor: inboxActorFromAuth(auth),
          action: "key.revoked",
        });
      }
      await recordAudit(db, {
        teamId: auth.teamId,
        actor: apiRequestActor(auth),
        action: "api_key.revoked",
        target: { type: "api_key", id: row.id },
      });
      return c.json({ object: "api_key" as const, id: row.id, deleted: true as const }, 200);
    },
  );
}
