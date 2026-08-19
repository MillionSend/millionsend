import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  type Keyring,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { type Env, errorBody, keysetPage } from "../app.js";
import {
  createWebhookRequestSchema,
  createWebhookResponseSchema,
  errorSchema,
  getWebhookResponseSchema,
  listQuerySchema,
  listWebhooksResponseSchema,
  removeWebhookResponseSchema,
  updateWebhookRequestSchema,
  webhookIdResponseSchema,
} from "../schemas.js";

export function registerWebhookRoutes(app: OpenAPIHono<Env>, db: Db, keyring: Keyring): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const w = schema.webhookEndpoints;

  // auto_disabled (delivery retries exhausted) is a dashboard-side state; the
  // wire union is enabled/disabled, so it reads as disabled here. PATCHing
  // status: "enabled" re-enables it either way.
  const wireStatus = (status: (typeof w.$inferSelect)["status"]): "enabled" | "disabled" =>
    status === "enabled" ? "enabled" : "disabled";

  const wire = (row: typeof w.$inferSelect) => ({
    id: row.id,
    endpoint: row.url,
    created_at: row.createdAt.toISOString(),
    status: wireStatus(row.status),
    // null = subscribed to all events (dashboard-created endpoints).
    events: row.events,
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/webhooks",
      request: {
        body: { content: { "application/json": { schema: createWebhookRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: createWebhookResponseSchema } },
          description: "Webhook created; signing_secret is also retrievable via GET /webhooks/{id}",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const secret = generateWebhookSecret();
      const encrypted = await encryptWebhookSecret(secret, keyring);
      const [row] = await db
        .insert(w)
        .values({
          teamId: auth.teamId,
          url: body.endpoint,
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretWrappedDek: encrypted.wrappedDek,
          secretKeyVersion: encrypted.keyVersion,
          secretLast4: secret.slice(-4),
          events: [...new Set(body.events)],
        })
        .returning({ id: w.id });
      if (!row) throw new Error("webhook insert returned no row");
      return c.json({ object: "webhook" as const, id: row.id, signing_secret: secret }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listWebhooksResponseSchema } },
          description: "Webhooks (list rows never carry the signing secret)",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: w.createdAt,
        id: w.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: w.createdAt, id: w.id })
              .from(w)
              .where(and(eq(w.id, id), eq(w.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(w)
            .where(and(eq(w.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(w.createdAt), desc(w.id)] : [asc(w.createdAt), asc(w.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        { object: "list" as const, data: page.rows.map(wire), has_more: page.hasMore },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getWebhookResponseSchema } },
          description: "Webhook, including its signing secret",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .select()
        .from(w)
        .where(and(eq(w.id, c.req.valid("param").id), eq(w.teamId, auth.teamId)));
      if (!row) return c.json(errorBody(404, "not_found", "Webhook not found"), 404);
      // Secrets are retrievable by design (SDK wire exposes signing_secret on
      // get) — envelope-encrypted at rest, decrypted per request.
      const secret = await decryptWebhookSecret(
        {
          ciphertext: row.secretCiphertext,
          iv: row.secretIv,
          wrappedDek: row.secretWrappedDek,
          keyVersion: row.secretKeyVersion,
        },
        keyring,
      );
      return c.json({ ...wire(row), object: "webhook" as const, signing_secret: secret }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/webhooks/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateWebhookRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: webhookIdResponseSchema } },
          description: "Webhook updated",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const set: Partial<typeof w.$inferInsert> = {};
      if (body.endpoint !== undefined) set.url = body.endpoint;
      if (body.events !== undefined) set.events = [...new Set(body.events)];
      if (body.status !== undefined) set.status = body.status;
      const scope = and(eq(w.id, id), eq(w.teamId, auth.teamId));
      // An empty PATCH body is a valid no-op, like the other resources.
      const [row] =
        Object.keys(set).length === 0
          ? await db.select({ id: w.id }).from(w).where(scope)
          : await db.update(w).set(set).where(scope).returning({ id: w.id });
      if (!row) return c.json(errorBody(404, "not_found", "Webhook not found"), 404);
      return c.json({ object: "webhook" as const, id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/webhooks/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeWebhookResponseSchema } },
          description: "Webhook deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      // Hard delete; the deliveries FK cascades, removing delivery history
      // (same as the dashboard).
      const [row] = await db
        .delete(w)
        .where(and(eq(w.id, c.req.valid("param").id), eq(w.teamId, auth.teamId)))
        .returning({ id: w.id });
      if (!row) return c.json(errorBody(404, "not_found", "Webhook not found"), 404);
      return c.json({ object: "webhook" as const, id: row.id, deleted: true as const }, 200);
    },
  );
}
