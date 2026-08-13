import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  beginIdempotent,
  canonicalBodyHash,
  completeIdempotent,
  decryptEmailBody,
  encryptEmailBody,
  extractTokenPrefix,
  findSuppressed,
  type Keyring,
  PLAN_DAILY_LIMIT,
  reserveDailyQuota,
  verifyApiKey,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  errorSchema,
  getEmailResponseSchema,
  sendEmailRequestSchema,
  sendEmailResponseSchema,
} from "./schemas.js";

export interface ApiDeps {
  db: Db;
  keyring: Keyring;
  /** Cloud enforces plan quotas; self-host sends without caps. */
  isCloud: boolean;
}

interface AuthContext {
  teamId: string;
  plan: (typeof schema.planEnum.enumValues)[number];
  apiKeyId: string;
}

type Env = { Variables: { auth: AuthContext } };

function apiError(status: 401 | 403 | 404 | 422, name: string, message: string) {
  return { json: { statusCode: status, name, message }, status } as const;
}

export function createApi(deps: ApiDeps): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>({
    // Resend-shaped validation errors instead of Hono's default.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            statusCode: 422,
            name: "validation_error",
            message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
          422,
        );
      }
    },
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "MillionSend API", version: "1.0.0" },
  });

  // Bearer auth for the /emails collection and everything under it.
  const requireApiKey = async (
    c: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const prefix = token ? extractTokenPrefix(token) : null;
    if (!token || !prefix) {
      const e = apiError(401, "missing_api_key", "Missing or malformed API key");
      return c.json(e.json, e.status);
    }
    const candidates = await deps.db
      .select({
        id: schema.apiKeys.id,
        keyHash: schema.apiKeys.keyHash,
        teamId: schema.apiKeys.teamId,
        plan: schema.teams.plan,
      })
      .from(schema.apiKeys)
      .innerJoin(schema.teams, eq(schema.apiKeys.teamId, schema.teams.id))
      .where(and(eq(schema.apiKeys.tokenPrefix, prefix), isNull(schema.apiKeys.revokedAt)));
    const match = candidates.find((k) => verifyApiKey(token, k.keyHash));
    if (!match) {
      const e = apiError(401, "invalid_api_key", "API key is invalid");
      return c.json(e.json, e.status);
    }
    c.set("auth", { teamId: match.teamId, plan: match.plan, apiKeyId: match.id });
    deps.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, match.id))
      .then(
        () => undefined,
        () => undefined,
      );
    await next();
  };
  app.use("/emails", requireApiKey);
  app.use("/emails/*", requireApiKey);

  const sendRoute = createRoute({
    method: "post",
    path: "/emails",
    request: {
      body: { content: { "application/json": { schema: sendEmailRequestSchema } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: sendEmailResponseSchema } },
        description: "Email accepted",
      },
      422: {
        content: { "application/json": { schema: errorSchema } },
        description: "Validation error",
      },
    },
  });

  app.openapi(sendRoute, async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    const suppressed = await findSuppressed(deps.db, auth.teamId, body.to);
    if (suppressed.size === body.to.length) {
      const e = apiError(422, "validation_error", "All recipients are suppressed");
      return c.json(e.json, e.status);
    }

    const idemKey = c.req.header("idempotency-key") ?? null;
    const bodyHash = canonicalBodyHash(body);
    if (idemKey) {
      const begin = await beginIdempotent(deps.db, {
        teamId: auth.teamId,
        key: idemKey,
        bodyHash,
      });
      if (begin.kind === "replay") {
        const first = begin.emailIds[0];
        if (first) return c.json({ id: first }, 200);
      }
      if (begin.kind === "conflict" || begin.kind === "in_flight") {
        const e = apiError(
          422,
          "validation_error",
          begin.kind === "conflict"
            ? "Idempotency key reused with a different payload"
            : "A request with this idempotency key is still processing",
        );
        return c.json(e.json, e.status);
      }
    }

    const encrypted = await encryptEmailBody(
      { html: body.html ?? null, text: body.text ?? null },
      deps.keyring,
    );

    const limit = deps.isCloud ? PLAN_DAILY_LIMIT[auth.plan] : null;
    // Quota reservation and email insert commit atomically (the quota
    // contract): a crash can never burn cap without a row, or vice versa.
    const emailId = await deps.db.transaction(async (tx) => {
      const quota = await reserveDailyQuota(tx as unknown as Db, {
        teamId: auth.teamId,
        count: 1,
        limit,
      });
      const [row] = await tx
        .insert(schema.emails)
        .values({
          teamId: auth.teamId,
          apiKeyId: auth.apiKeyId,
          from: body.from,
          to: body.to,
          cc: body.cc ?? null,
          bcc: body.bcc ?? null,
          replyTo: body.reply_to ?? null,
          subject: body.subject,
          tags: body.tags ? Object.fromEntries(body.tags.map((t) => [t.name, t.value])) : null,
          latestStatus: quota.reserved ? "queued" : "queued_quota",
          bodyCiphertext: encrypted.ciphertext,
          bodyIv: encrypted.iv,
          bodyWrappedDek: encrypted.wrappedDek,
          bodyKeyVersion: encrypted.keyVersion,
        })
        .returning({ id: schema.emails.id });
      if (!row) throw new Error("email insert returned no row");
      if (idemKey) {
        await completeIdempotent(tx as unknown as Db, {
          teamId: auth.teamId,
          key: idemKey,
          emailIds: [row.id],
        });
      }
      return row.id;
    });

    return c.json({ id: emailId }, 200);
  });

  const getRoute = createRoute({
    method: "get",
    path: "/emails/{id}",
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        content: { "application/json": { schema: getEmailResponseSchema } },
        description: "Email",
      },
      404: {
        content: { "application/json": { schema: errorSchema } },
        description: "Not found",
      },
    },
  });

  app.openapi(getRoute, async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const [email] = await deps.db
      .select()
      .from(schema.emails)
      .where(and(eq(schema.emails.id, id), eq(schema.emails.teamId, auth.teamId)));
    if (!email) {
      const e = apiError(404, "not_found", "Email not found");
      return c.json(e.json, e.status);
    }
    let html: string | null = null;
    let text: string | null = null;
    const { bodyCiphertext, bodyIv, bodyWrappedDek, bodyKeyVersion } = email;
    if (bodyCiphertext && bodyIv && bodyWrappedDek && bodyKeyVersion !== null) {
      try {
        const body = await decryptEmailBody(
          {
            ciphertext: bodyCiphertext,
            iv: bodyIv,
            wrappedDek: bodyWrappedDek,
            keyVersion: bodyKeyVersion,
          },
          deps.keyring,
        );
        html = body.html;
        text = body.text;
      } catch {
        // Corrupt or purged body must not 500 the metadata read.
      }
    }
    return c.json(
      {
        object: "email" as const,
        id: email.id,
        from: email.from,
        to: email.to,
        cc: email.cc ?? null,
        bcc: email.bcc ?? null,
        reply_to: email.replyTo ?? null,
        subject: email.subject,
        html,
        text,
        created_at: email.createdAt.toISOString(),
        last_event: email.latestStatus,
      },
      200,
    );
  });

  return app;
}
