import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { type Env, errorBody, isUniqueViolation, keysetPage } from "../app.js";
import {
  createTemplateRequestSchema,
  errorSchema,
  getTemplateResponseSchema,
  listQuerySchema,
  listTemplatesResponseSchema,
  removeTemplateResponseSchema,
  templateIdResponseSchema,
  updateTemplateRequestSchema,
} from "../schemas.js";

const NO_PUBLISH_CYCLE =
  "Templates have no draft/publish cycle: every save is live, so status is always published.";

export function registerTemplateRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  // The resend SDK passes one "identifier" (id or alias) to every
  // single-template call.
  const idParam = z.object({ id: z.string().min(1).describe("Template id or alias") });
  const t = schema.templates;

  const listItem = (row: typeof t.$inferSelect) => ({
    id: row.id,
    name: row.name,
    alias: row.alias,
    status: "published" as const,
    published_at: row.createdAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });

  const wire = (row: typeof t.$inferSelect) => ({
    object: "template" as const,
    ...listItem(row),
    current_version_id: row.id,
    from: null,
    subject: row.subject,
    reply_to: null,
    html: row.html,
    text: row.text,
    variables: [],
    has_unpublished_versions: false as const,
  });

  const byIdOrAlias = (teamId: string, idOrAlias: string) =>
    and(
      eq(t.teamId, teamId),
      z.uuid().safeParse(idOrAlias).success ? eq(t.id, idOrAlias) : eq(t.alias, idOrAlias),
    );

  const findTemplate = async (teamId: string, idOrAlias: string) =>
    (await db.select().from(t).where(byIdOrAlias(teamId, idOrAlias)))[0];

  const notFound = () => errorBody(404, "not_found", "Template not found");

  // null carries nothing to drop, so it is not an unsupported value.
  const unsupportedField = (body: {
    from?: unknown;
    reply_to?: unknown;
    variables?: unknown[] | undefined;
  }): string | null =>
    body.from != null
      ? "from"
      : body.reply_to != null
        ? "reply_to"
        : body.variables?.length
          ? "variables"
          : null;

  const aliasTaken = () => errorBody(409, "validation_error", "Template alias already exists");

  app.openapi(
    createRoute({
      method: "post",
      path: "/templates",
      request: {
        body: { content: { "application/json": { schema: createTemplateRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: templateIdResponseSchema } },
          description: `Template created. ${NO_PUBLISH_CYCLE}`,
        },
        409: jsonErr("Alias already in use"),
        422: jsonErr("Validation error, including from/reply_to/variables (not supported yet)"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const unsupported = unsupportedField(body);
      if (unsupported) {
        return c.json(
          errorBody(422, "validation_error", `${unsupported} is not supported on templates yet`),
          422,
        );
      }
      try {
        const [row] = await db
          .insert(t)
          .values({
            teamId: auth.teamId,
            name: body.name,
            alias: body.alias ?? null,
            subject: body.subject || null,
            html: body.html,
            text: body.text || null,
          })
          .returning({ id: t.id });
        if (!row) throw new Error("template insert returned no row");
        return c.json({ object: "template" as const, id: row.id }, 200);
      } catch (error) {
        if (isUniqueViolation(error)) return c.json(aliasTaken(), 409);
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/templates",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listTemplatesResponseSchema } },
          description: "Templates",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: t.createdAt,
        id: t.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: t.createdAt, id: t.id })
              .from(t)
              .where(and(eq(t.id, id), eq(t.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(t)
            .where(and(eq(t.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(t.createdAt), desc(t.id)] : [asc(t.createdAt), asc(t.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        { object: "list" as const, data: page.rows.map(listItem), has_more: page.hasMore },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/templates/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getTemplateResponseSchema } },
          description: `Template by id or alias. ${NO_PUBLISH_CYCLE} from, reply_to and variables are not supported yet and read as null, null and [].`,
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const row = await findTemplate(auth.teamId, c.req.valid("param").id);
      if (!row) return c.json(notFound(), 404);
      return c.json(wire(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/templates/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateTemplateRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: templateIdResponseSchema } },
          description: "Template updated (live immediately)",
        },
        404: jsonErr("Not found"),
        409: jsonErr("Alias already in use"),
        422: jsonErr("Validation error, including from/reply_to/variables (not supported yet)"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const unsupported = unsupportedField(body);
      if (unsupported) {
        return c.json(
          errorBody(422, "validation_error", `${unsupported} is not supported on templates yet`),
          422,
        );
      }
      const set: Partial<typeof t.$inferInsert> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.alias !== undefined) set.alias = body.alias;
      if (body.subject !== undefined) set.subject = body.subject || null;
      if (body.html !== undefined) set.html = body.html;
      if (body.text !== undefined) set.text = body.text || null;
      // The dashboard editor treats `document` as the source of truth and
      // re-renders html/text from it on every save, so a raw html/text write
      // must drop it or be silently overwritten on the next dashboard save.
      if (set.html !== undefined || set.text !== undefined) set.document = null;
      const scope = byIdOrAlias(auth.teamId, c.req.valid("param").id);
      // An empty PATCH body is a valid no-op, like the other resources.
      if (Object.keys(set).length === 0) {
        const [row] = await db.select({ id: t.id }).from(t).where(scope);
        if (!row) return c.json(notFound(), 404);
        return c.json({ object: "template" as const, id: row.id }, 200);
      }
      try {
        const [row] = await db
          .update(t)
          .set({ ...set, updatedAt: new Date() })
          .where(scope)
          .returning({ id: t.id });
        if (!row) return c.json(notFound(), 404);
        return c.json({ object: "template" as const, id: row.id }, 200);
      } catch (error) {
        if (isUniqueViolation(error)) return c.json(aliasTaken(), 409);
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/templates/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeTemplateResponseSchema } },
          description: "Template deleted. Broadcasts keep their own copy of the content.",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .delete(t)
        .where(byIdOrAlias(auth.teamId, c.req.valid("param").id))
        .returning({ id: t.id });
      if (!row) return c.json(notFound(), 404);
      return c.json({ object: "template" as const, id: row.id, deleted: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/templates/{id}/publish",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: templateIdResponseSchema } },
          description: `No-op kept for SDK compatibility. ${NO_PUBLISH_CYCLE}`,
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .select({ id: t.id })
        .from(t)
        .where(byIdOrAlias(auth.teamId, c.req.valid("param").id));
      if (!row) return c.json(notFound(), 404);
      return c.json({ object: "template" as const, id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/templates/{id}/duplicate",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: templateIdResponseSchema } },
          description: 'Copy named "<name> (copy)" with no alias; returns the new template id',
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const source = await findTemplate(auth.teamId, c.req.valid("param").id);
      if (!source) return c.json(notFound(), 404);
      const [row] = await db
        .insert(t)
        .values({
          teamId: auth.teamId,
          name: `${source.name} (copy)`,
          subject: source.subject,
          html: source.html,
          text: source.text,
          document: source.document,
        })
        .returning({ id: t.id });
      if (!row) throw new Error("template insert returned no row");
      return c.json({ object: "template" as const, id: row.id }, 200);
    },
  );
}
