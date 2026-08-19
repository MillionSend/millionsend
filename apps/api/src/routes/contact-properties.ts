import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { type Env, errorBody, keysetPage, numericPropertyValue } from "../app.js";
import {
  contactPropertyIdResponseSchema,
  createContactPropertyRequestSchema,
  errorSchema,
  getContactPropertyResponseSchema,
  listContactPropertiesResponseSchema,
  listQuerySchema,
  removeContactPropertyResponseSchema,
  updateContactPropertyRequestSchema,
} from "../schemas.js";

export function registerContactPropertyRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const p = schema.contactProperties;

  /**
   * fallback_value is stored as text; a 'number' property only accepts values
   * that read back as a finite number, so the typed wire never emits NaN.
   */
  const storedFallback = (
    type: "string" | "number",
    value: string | number | null | undefined,
  ): { ok: true; stored: string | null } | { ok: false } => {
    if (value === null || value === undefined) return { ok: true, stored: null };
    if (type === "number" && numericPropertyValue(value) === null) return { ok: false };
    return { ok: true, stored: String(value) };
  };

  const wire = (row: typeof p.$inferSelect) => ({
    id: row.id,
    created_at: row.createdAt.toISOString(),
    key: row.key,
    type: row.type,
    fallback_value:
      row.fallbackValue === null
        ? null
        : row.type === "number"
          ? // Writes validate numeric fallbacks, so this is always finite.
            Number(row.fallbackValue)
          : row.fallbackValue,
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/contact-properties",
      request: {
        body: { content: { "application/json": { schema: createContactPropertyRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: contactPropertyIdResponseSchema } },
          description: "Contact property created",
        },
        409: jsonErr("Property already exists"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const fallback = storedFallback(body.type, body.fallback_value);
      if (!fallback.ok) {
        return c.json(errorBody(422, "validation_error", "fallback_value must be a number"), 422);
      }
      // Duplicate = the case-insensitive (teamId, lower(key)) unique index.
      // "validation_error" (not "conflict"): the name must be a
      // RESEND_ERROR_CODE_KEY member for SDK clients.
      const [row] = await db
        .insert(p)
        .values({
          teamId: auth.teamId,
          key: body.key,
          type: body.type,
          fallbackValue: fallback.stored,
        })
        .onConflictDoNothing()
        .returning({ id: p.id });
      if (!row) {
        return c.json(errorBody(409, "validation_error", "Property already exists"), 409);
      }
      return c.json({ object: "contact_property" as const, id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/contact-properties",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listContactPropertiesResponseSchema } },
          description: "Contact properties",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: p.createdAt,
        id: p.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: p.createdAt, id: p.id })
              .from(p)
              .where(and(eq(p.id, id), eq(p.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(p)
            .where(and(eq(p.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(p.createdAt), desc(p.id)] : [asc(p.createdAt), asc(p.id)]),
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
      path: "/contact-properties/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getContactPropertyResponseSchema } },
          description: "Contact property",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .select()
        .from(p)
        .where(and(eq(p.id, c.req.valid("param").id), eq(p.teamId, auth.teamId)));
      if (!row) return c.json(errorBody(404, "not_found", "Property not found"), 404);
      return c.json({ ...wire(row), object: "contact_property" as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/contact-properties/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateContactPropertyRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: contactPropertyIdResponseSchema } },
          description: "Contact property updated",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const [existing] = await db
        .select({ type: p.type })
        .from(p)
        .where(and(eq(p.id, id), eq(p.teamId, auth.teamId)));
      if (!existing) return c.json(errorBody(404, "not_found", "Property not found"), 404);
      // The SDK sends {} when fallbackValue is omitted — a valid no-op.
      if (body.fallback_value !== undefined) {
        const fallback = storedFallback(existing.type, body.fallback_value);
        if (!fallback.ok) {
          return c.json(errorBody(422, "validation_error", "fallback_value must be a number"), 422);
        }
        await db
          .update(p)
          .set({ fallbackValue: fallback.stored })
          .where(and(eq(p.id, id), eq(p.teamId, auth.teamId)));
      }
      return c.json({ object: "contact_property" as const, id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/contact-properties/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeContactPropertyResponseSchema } },
          description: "Contact property deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      // Only the definition is removed — values in contacts.properties are
      // untouched (same as the dashboard); those keys read as strings again.
      const [row] = await db
        .delete(p)
        .where(and(eq(p.id, c.req.valid("param").id), eq(p.teamId, auth.teamId)))
        .returning({ id: p.id });
      if (!row) return c.json(errorBody(404, "not_found", "Property not found"), 404);
      return c.json(
        { object: "contact_property" as const, id: row.id, deleted: true as const },
        200,
      );
    },
  );
}
