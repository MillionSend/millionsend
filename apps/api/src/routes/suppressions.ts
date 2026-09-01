import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ERASED_TOMBSTONE,
  extractAddrSpec,
  hashRecipient,
  normalizeAddress,
  suppressionHashesFor,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type Env, errorBody, keysetPage } from "../app.js";
import {
  batchAddSuppressionsRequestSchema,
  batchAddSuppressionsResponseSchema,
  batchRemoveSuppressionsRequestSchema,
  batchRemoveSuppressionsResponseSchema,
  createSuppressionRequestSchema,
  errorSchema,
  getSuppressionResponseSchema,
  listSuppressionsQuerySchema,
  listSuppressionsResponseSchema,
  removeSuppressionResponseSchema,
  SUPPRESSION_ORIGIN_BY_REASON,
  type SuppressionOrigin,
  type SuppressionReason,
  suppressionIdResponseSchema,
} from "../schemas.js";

const ERASED_ROWS_NOTE =
  "Rows whose address was erased (GDPR/LGPD) keep blocking sends but are hidden from the list and from lookups by email; they are reachable by id only.";

export function registerSuppressionRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.string().min(1) });
  const s = schema.suppressions;

  const reasonByOrigin = Object.fromEntries(
    Object.entries(SUPPRESSION_ORIGIN_BY_REASON).map(([reason, origin]) => [origin, reason]),
  ) as Record<SuppressionOrigin, SuppressionReason>;

  const wire = (row: typeof s.$inferSelect) => ({
    id: row.id,
    email: row.email ?? ERASED_TOMBSTONE,
    origin: SUPPRESSION_ORIGIN_BY_REASON[row.reason],
    source_id: row.sourceEmailId,
    created_at: row.createdAt.toISOString(),
  });

  // The path segment is the suppression UUID or the address — the resend SDK
  // sends either through one parameter. Address lookups match every hash form
  // a stored row may carry and skip erased rows (address column nulled).
  const byIdOrEmail = (teamId: string, idOrEmail: string) =>
    and(
      eq(s.teamId, teamId),
      z.uuid().safeParse(idOrEmail).success
        ? eq(s.id, idOrEmail)
        : and(isNotNull(s.email), inArray(s.emailHash, suppressionHashesFor(idOrEmail))),
    );

  /**
   * Blocks every address, returning one id per distinct normalized address
   * in first-occurrence order. An address already suppressed for any reason
   * (erased rows included) keeps its row untouched and reports its id:
   * suppressing is "make sure this is blocked", not "record why".
   */
  const ensureSuppressed = async (teamId: string, emails: string[]): Promise<string[]> => {
    const entries = [...new Set(emails.map((e) => normalizeAddress(extractAddrSpec(e))))].map(
      (address) => ({ address, hashes: suppressionHashesFor(address) }),
    );
    const existing = await db
      .select({ id: s.id, emailHash: s.emailHash })
      .from(s)
      .where(
        and(
          eq(s.teamId, teamId),
          inArray(
            s.emailHash,
            entries.flatMap((e) => e.hashes),
          ),
        ),
      );
    const idByHash = new Map(existing.map((r) => [r.emailHash, r.id]));
    const missing = entries.filter((e) => !e.hashes.some((h) => idByHash.has(h)));
    if (missing.length > 0) {
      // A concurrent insert of the same address is absorbed by the no-op
      // conflict update, which still returns the surviving row's id.
      const inserted = await db
        .insert(s)
        .values(
          missing.map((e) => ({
            teamId,
            email: e.address,
            emailHash: hashRecipient(e.address),
            reason: "manual" as const,
          })),
        )
        .onConflictDoUpdate({
          target: [s.teamId, s.emailHash],
          set: { emailHash: sql`excluded.email_hash` },
        })
        .returning({ id: s.id, emailHash: s.emailHash });
      for (const r of inserted) idByHash.set(r.emailHash, r.id);
    }
    return entries.map((e) => {
      const id = e.hashes.map((h) => idByHash.get(h)).find((v) => v !== undefined);
      if (!id) throw new Error("suppression upsert returned no row");
      return id;
    });
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/suppressions/batch/add",
      request: {
        body: { content: { "application/json": { schema: batchAddSuppressionsRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: batchAddSuppressionsResponseSchema } },
          description:
            "One entry per distinct address (case-insensitive) in input order; addresses already suppressed for any reason return their existing id. Accepts up to 1000 addresses (Resend: 100).",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const ids = await ensureSuppressed(auth.teamId, c.req.valid("json").emails);
      return c.json({ data: ids.map((id) => ({ object: "suppression" as const, id })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/suppressions/batch/remove",
      request: {
        body: {
          content: { "application/json": { schema: batchRemoveSuppressionsRequestSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: batchRemoveSuppressionsResponseSchema } },
          description: `Exactly one of emails or ids (up to 1000 each); lists only the rows actually removed. ${ERASED_ROWS_NOTE}`,
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const match =
        body.ids !== undefined
          ? inArray(s.id, body.ids)
          : and(
              isNotNull(s.email),
              inArray(
                s.emailHash,
                (body.emails ?? []).flatMap((e) => suppressionHashesFor(e)),
              ),
            );
      const rows = await db
        .delete(s)
        .where(and(eq(s.teamId, auth.teamId), match))
        .returning({ id: s.id });
      return c.json(
        {
          data: rows.map((r) => ({
            object: "suppression" as const,
            id: r.id,
            deleted: true as const,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/suppressions",
      request: {
        body: { content: { "application/json": { schema: createSuppressionRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: suppressionIdResponseSchema } },
          description:
            "Address blocked with origin manual. Idempotent: an address already suppressed for any reason (bounce, complaint, unsubscribe, manual) keeps its entry and its existing id is returned.",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [id] = await ensureSuppressed(auth.teamId, [c.req.valid("json").email]);
      if (!id) throw new Error("suppression upsert returned no row");
      return c.json({ object: "suppression" as const, id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/suppressions",
      request: { query: listSuppressionsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listSuppressionsResponseSchema } },
          description: `Suppressions, optionally filtered by origin (bounce, complaint, manual, or the superset value unsubscribe for retained one-click opt-outs). ${ERASED_ROWS_NOTE}`,
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const query = c.req.valid("query");
      const scope = and(
        eq(s.teamId, auth.teamId),
        isNotNull(s.email),
        query.origin === undefined ? undefined : eq(s.reason, reasonByOrigin[query.origin]),
      );
      const page = await keysetPage({
        query,
        createdAt: s.createdAt,
        id: s.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: s.createdAt, id: s.id })
              .from(s)
              .where(and(eq(s.id, id), eq(s.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(s)
            .where(and(scope, cond))
            .orderBy(
              ...(descending ? [desc(s.createdAt), desc(s.id)] : [asc(s.createdAt), asc(s.id)]),
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
      path: "/suppressions/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getSuppressionResponseSchema } },
          description: `Suppression by id or by email address. ${ERASED_ROWS_NOTE} An erased row reports "${ERASED_TOMBSTONE}" as its email.`,
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .select()
        .from(s)
        .where(byIdOrEmail(auth.teamId, c.req.valid("param").id));
      if (!row) return c.json(errorBody(404, "not_found", "Suppression not found"), 404);
      return c.json({ ...wire(row), object: "suppression" as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/suppressions/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeSuppressionResponseSchema } },
          description: `Suppression removed, by id or by email address; the address can receive mail again. ${ERASED_ROWS_NOTE}`,
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .delete(s)
        .where(byIdOrEmail(auth.teamId, c.req.valid("param").id))
        .returning({ id: s.id });
      if (!row) return c.json(errorBody(404, "not_found", "Suppression not found"), 404);
      return c.json({ object: "suppression" as const, id: row.id, deleted: true as const }, 200);
    },
  );
}
