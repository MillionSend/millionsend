import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  beginIdempotent,
  canonicalBodyHash,
  completeIdempotent,
  decryptEmailBody,
  encryptEmailBody,
  extractAddrSpec,
  extractTokenPrefix,
  findSuppressed,
  type Keyring,
  PLAN_DAILY_LIMIT,
  releaseIdempotent,
  reserveDailyQuota,
  verifyApiKey,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
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

const LAST_USED_STAMP_INTERVAL_MS = 60_000;

class IdempotencyTakeoverError extends Error {
  constructor() {
    super("idempotency claim taken over");
  }
}

function errorBody(status: number, name: string, message: string) {
  return { statusCode: status, name, message };
}

function senderDomain(from: string): string | null {
  const addr = extractAddrSpec(from);
  const at = addr.lastIndexOf("@");
  return at > 0 ? addr.slice(at + 1).toLowerCase() : null;
}

export function createApi(deps: ApiDeps): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          ),
          422,
        );
      }
    },
  });

  // Uncaught throws must still speak Resend's error format — SDK clients
  // parse the body as JSON.
  app.onError((err, c) => {
    console.error("unhandled api error", err);
    return c.json(errorBody(500, "internal_server_error", "An unexpected error occurred"), 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "MillionSend API", version: "1.0.0" },
  });

  const requireApiKey = createMiddleware<Env>(async (c, next) => {
    // Both /emails and /emails/* register this; skip the second pass.
    if (c.get("auth")) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const prefix = token ? extractTokenPrefix(token) : null;
    if (!token || !prefix) {
      return c.json(errorBody(401, "missing_api_key", "Missing or malformed API key"), 401);
    }
    const candidates = await deps.db
      .select({
        id: schema.apiKeys.id,
        keyHash: schema.apiKeys.keyHash,
        teamId: schema.apiKeys.teamId,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        plan: schema.teams.plan,
      })
      .from(schema.apiKeys)
      .innerJoin(schema.teams, eq(schema.apiKeys.teamId, schema.teams.id))
      .where(and(eq(schema.apiKeys.tokenPrefix, prefix), isNull(schema.apiKeys.revokedAt)));
    const match = candidates.find((k) => verifyApiKey(token, k.keyHash));
    if (!match) {
      return c.json(errorBody(401, "invalid_api_key", "API key is invalid"), 401);
    }
    c.set("auth", { teamId: match.teamId, plan: match.plan, apiKeyId: match.id });
    const now = Date.now();
    if (!match.lastUsedAt || now - match.lastUsedAt.getTime() > LAST_USED_STAMP_INTERVAL_MS) {
      deps.db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(schema.apiKeys.id, match.id))
        .then(
          () => undefined,
          () => undefined,
        );
    }
    await next();
  });
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
      409: {
        content: { "application/json": { schema: errorSchema } },
        description: "Idempotency conflict",
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

    if (body.attachments && body.attachments.length > 0) {
      return c.json(errorBody(422, "validation_error", "Attachments are not yet supported"), 422);
    }

    // Sender domain must be one of the team's verified domains — otherwise
    // any key could queue mail claiming any sender.
    const fromDomain = senderDomain(body.from);
    const domain = fromDomain
      ? (
          await deps.db
            .select({ id: schema.domains.id, status: schema.domains.status })
            .from(schema.domains)
            .where(and(eq(schema.domains.teamId, auth.teamId), eq(schema.domains.name, fromDomain)))
        )[0]
      : undefined;
    if (domain?.status !== "verified") {
      return c.json(
        errorBody(
          422,
          "validation_error",
          `The ${fromDomain ?? "sender"} domain is not verified for this team`,
        ),
        422,
      );
    }

    // Idempotency FIRST: a replay must return the stored response even if
    // recipients were suppressed after the original send.
    const idemKey = c.req.header("idempotency-key") ?? null;
    if (idemKey) {
      const begin = await beginIdempotent(deps.db, {
        teamId: auth.teamId,
        key: idemKey,
        bodyHash: canonicalBodyHash(body),
      });
      if (begin.kind === "replay") {
        const first = begin.emailIds[0];
        if (first) return c.json({ id: first }, 200);
        return c.json(
          errorBody(409, "concurrent_idempotent_requests", "Idempotency record is incomplete"),
          409,
        );
      }
      if (begin.kind === "conflict") {
        return c.json(
          errorBody(
            409,
            "invalid_idempotent_request",
            "Idempotency key was used with a different payload",
          ),
          409,
        );
      }
      if (begin.kind === "in_flight") {
        return c.json(
          errorBody(
            409,
            "concurrent_idempotent_requests",
            "A request with this idempotency key is still processing",
          ),
          409,
        );
      }
    }

    try {
      // Suppression: dedupe, check every recipient field, and strip
      // suppressed addresses; refuse only when no `to` recipient remains.
      const allRecipients = [...new Set([...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])])];
      const suppressed = await findSuppressed(deps.db, auth.teamId, allRecipients);
      const keep = (list: string[] | undefined) => list?.filter((r) => !suppressed.has(r));
      const to = keep(body.to) ?? [];
      if (to.length === 0) {
        if (idemKey) await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey });
        return c.json(errorBody(422, "validation_error", "All recipients are suppressed"), 422);
      }
      const cc = keep(body.cc);
      const bcc = keep(body.bcc);

      const encrypted = await encryptEmailBody(
        { html: body.html ?? null, text: body.text ?? null },
        deps.keyring,
      );

      const limit = deps.isCloud ? PLAN_DAILY_LIMIT[auth.plan] : null;
      // Quota reservation, email insert, and idempotency completion commit
      // atomically (the quota contract).
      const emailId = await deps.db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const quota = await reserveDailyQuota(txDb, { teamId: auth.teamId, count: 1, limit });
        const [row] = await tx
          .insert(schema.emails)
          .values({
            teamId: auth.teamId,
            domainId: domain.id,
            apiKeyId: auth.apiKeyId,
            from: body.from,
            to,
            cc: cc && cc.length > 0 ? cc : null,
            bcc: bcc && bcc.length > 0 ? bcc : null,
            replyTo: body.reply_to ?? null,
            subject: body.subject,
            tags: body.tags ? Object.fromEntries(body.tags.map((t) => [t.name, t.value])) : null,
            latestStatus: quota.reserved ? "queued" : "queued_quota",
            scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
            bodyCiphertext: encrypted.ciphertext,
            bodyIv: encrypted.iv,
            bodyWrappedDek: encrypted.wrappedDek,
            bodyKeyVersion: encrypted.keyVersion,
          })
          .returning({ id: schema.emails.id });
        if (!row) throw new Error("email insert returned no row");
        if (idemKey) {
          const recorded = await completeIdempotent(txDb, {
            teamId: auth.teamId,
            key: idemKey,
            emailIds: [row.id],
          });
          // Another owner took over and recorded its own response: abort so
          // this branch produces no second email.
          if (!recorded) throw new IdempotencyTakeoverError();
        }
        return row.id;
      });
      return c.json({ id: emailId }, 200);
    } catch (err) {
      if (err instanceof IdempotencyTakeoverError && idemKey) {
        const replay = await beginIdempotent(deps.db, {
          teamId: auth.teamId,
          key: idemKey,
          bodyHash: canonicalBodyHash(body),
        });
        if (replay.kind === "replay" && replay.emailIds[0]) {
          return c.json({ id: replay.emailIds[0] }, 200);
        }
        return c.json(
          errorBody(409, "concurrent_idempotent_requests", "Request superseded by a retry"),
          409,
        );
      }
      // A failed request must not brick its idempotency key for the lease.
      if (idemKey) {
        await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey }).catch(() => {});
      }
      throw err;
    }
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
      return c.json(errorBody(404, "not_found", "Email not found"), 404);
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
        scheduled_at: email.scheduledAt?.toISOString() ?? null,
        last_event: email.latestStatus,
      },
      200,
    );
  });

  return app;
}
