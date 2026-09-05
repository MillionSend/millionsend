import { randomBytes, randomUUID } from "node:crypto";
import { env } from "@millionsend/config";
import {
  decryptWebhookSigningSecrets,
  encryptWebhookSecret,
  generateWebhookSecret,
  postFailureCode,
  postJson,
  resultRows,
  rotatedWebhookSecretColumns,
  rotationOverlapEnd,
  signWebhook,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_ROTATION_DEFAULT_OVERLAP_HOURS,
  WEBHOOK_ROTATION_MAX_OVERLAP_HOURS,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { getKeyring } from "../keyring";
import { adminProcedure, router, teamProcedure } from "../trpc";

const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", { message: "must be an https:// URL" });

// The schema stores null = subscribed to every event; an omitted or empty
// input normalizes to null. The UI renders null as "All".
const eventTypesInput = z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length);

function toStoredEvents(eventTypes: readonly string[] | undefined): string[] | null {
  return eventTypes && eventTypes.length > 0 ? [...eventTypes] : null;
}

const descriptionInput = z.string().trim().max(200);

/** Empty/whitespace descriptions store as null, not "". */
function toStoredDescription(description: string | undefined | null): string | null {
  return description?.length ? description : null;
}

const SUCCESS_RATE_WINDOW = 30;

// Test fires are synchronous outbound requests from the app's egress. Ports
// and volume are pinned so the button cannot double as a port scanner or a
// reachability probe (the ordinary delivery path is async and retried).
const TEST_DELIVERY_PORTS = new Set(["", "443", "8443"]);
const TEST_DELIVERY_PER_MINUTE = 10;

function testPortAllowed(url: string): boolean {
  return env.WEBHOOK_ALLOW_LOCALHOST || TEST_DELIVERY_PORTS.has(new URL(url).port);
}

/** Test deliveries this team fired in the last minute (DB window: works across app instances). */
async function recentTestDeliveries(db: Db, teamId: string): Promise<number> {
  const d = schema.webhookDeliveries;
  const t = schema.webhookEndpoints;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(d)
    .innerJoin(t, eq(d.endpointId, t.id))
    .where(
      and(
        eq(t.teamId, teamId),
        sql`${d.payload}->>'test' = 'true'`,
        gt(d.createdAt, new Date(Date.now() - 60_000)),
      ),
    );
  return row?.n ?? 0;
}

function toEnabled(status: (typeof schema.webhookEndpoints.$inferSelect)["status"]): boolean {
  return status === "enabled";
}

/**
 * Per-endpoint success rate over the last SUCCESS_RATE_WINDOW deliveries:
 * success / settled (pending rows are still in flight and count for neither
 * side). Null when nothing has settled yet. One LATERAL per endpoint reads
 * exactly the window off the (endpoint_id, created_at) index; a window
 * function over every delivery row would read the endpoint's whole history.
 */
async function successRates(db: Db, endpointIds: string[]): Promise<Map<string, number | null>> {
  const rates = new Map<string, number | null>(endpointIds.map((id) => [id, null]));
  if (endpointIds.length === 0) return rates;
  const d = schema.webhookDeliveries;
  const ids = sql.join(
    endpointIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const stats = resultRows<{ id: string; settled: number; succeeded: number }>(
    await db.execute(sql`
      select e.id,
             count(*) filter (where recent.status in ('success', 'failed', 'exhausted'))::int as settled,
             count(*) filter (where recent.status = 'success')::int as succeeded
      from unnest(array[${ids}]) as e(id)
      cross join lateral (
        select ${d.status} as status
        from ${d}
        where ${d.endpointId} = e.id
        order by ${d.createdAt} desc, ${d.id} desc
        limit ${SUCCESS_RATE_WINDOW}
      ) recent
      group by e.id
    `),
  );
  for (const row of stats) {
    rates.set(row.id, row.settled > 0 ? Math.round((100 * row.succeeded) / row.settled) : null);
  }
  return rates;
}

const deliveryListColumns = {
  id: schema.webhookDeliveries.id,
  eventType: schema.webhookDeliveries.eventType,
  status: schema.webhookDeliveries.status,
  attempts: schema.webhookDeliveries.attempts,
  lastResponseCode: schema.webhookDeliveries.lastResponseCode,
  lastAttemptAt: schema.webhookDeliveries.lastAttemptAt,
  nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
  createdAt: schema.webhookDeliveries.createdAt,
};

async function requireEndpoint(db: Db, teamId: string, id: string) {
  const t = schema.webhookEndpoints;
  const [row] = await db
    .select({ id: t.id, url: t.url })
    .from(t)
    .where(and(eq(t.id, id), eq(t.teamId, teamId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

export const webhooksRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const t = schema.webhookEndpoints;
    const endpoints = await ctx.db
      .select({
        id: t.id,
        url: t.url,
        description: t.description,
        events: t.events,
        status: t.status,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.teamId, ctx.teamId))
      .orderBy(desc(t.createdAt));
    const rates = await successRates(
      ctx.db,
      endpoints.map((e) => e.id),
    );
    return endpoints.map((e) => ({
      id: e.id,
      url: e.url,
      description: e.description,
      eventTypes: e.events,
      enabled: toEnabled(e.status),
      status: e.status,
      createdAt: e.createdAt,
      successRate: rates.get(e.id) ?? null,
    }));
  }),

  create: adminProcedure
    .input(
      z.object({
        url: httpsUrl,
        description: descriptionInput.optional(),
        eventTypes: eventTypesInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const secret = generateWebhookSecret();
      const id = randomUUID();
      const encrypted = await encryptWebhookSecret(secret, getKeyring(), {
        teamId: ctx.teamId,
        rowId: id,
      });
      const [row] = await ctx.db
        .insert(schema.webhookEndpoints)
        .values({
          id,
          teamId: ctx.teamId,
          url: input.url,
          description: toStoredDescription(input.description),
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretWrappedDek: encrypted.wrappedDek,
          secretKeyVersion: encrypted.keyVersion,
          secretLast4: secret.slice(-4),
          events: toStoredEvents(input.eventTypes),
        })
        .returning({ id: schema.webhookEndpoints.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await recordAudit(ctx, {
        action: "webhook.created",
        target: { type: "webhook", id: row.id },
        metadata: { url: input.url },
      });
      // The full secret exists only in this response — the row stores only
      // ciphertext, and no other code path returns or logs the plaintext.
      return { id: row.id, secret };
    }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const t = schema.webhookEndpoints;
    // Explicit columns: the secret ciphertext never leaves the server, and
    // of the secret only last4 reaches the client — enough for the mask.
    const [row] = await ctx.db
      .select({
        id: t.id,
        url: t.url,
        description: t.description,
        events: t.events,
        status: t.status,
        createdAt: t.createdAt,
        secretLast4: t.secretLast4,
        prevSecretExpiresAt: t.prevSecretExpiresAt,
      })
      .from(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return {
      id: row.id,
      url: row.url,
      description: row.description,
      eventTypes: row.events,
      enabled: toEnabled(row.status),
      status: row.status,
      createdAt: row.createdAt,
      secretLast4: row.secretLast4,
      // Set while a rotation's overlap is open: deliveries carry both signatures.
      previousSecretExpiresAt:
        row.prevSecretExpiresAt && row.prevSecretExpiresAt > new Date()
          ? row.prevSecretExpiresAt
          : null,
    };
  }),

  update: adminProcedure
    .input(
      z
        .object({
          id: z.uuid(),
          url: httpsUrl.optional(),
          description: descriptionInput.nullable().optional(),
          eventTypes: eventTypesInput.optional(),
          enabled: z.boolean().optional(),
        })
        .refine(
          (v) =>
            v.url !== undefined ||
            v.description !== undefined ||
            v.eventTypes !== undefined ||
            v.enabled !== undefined,
          { message: "nothing to update" },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      const t = schema.webhookEndpoints;
      const set: Partial<typeof t.$inferInsert> = {};
      if (input.url !== undefined) set.url = input.url;
      if (input.description !== undefined) set.description = toStoredDescription(input.description);
      if (input.eventTypes !== undefined) set.events = toStoredEvents(input.eventTypes);
      if (input.enabled !== undefined) set.status = input.enabled ? "enabled" : "disabled";
      const [row] = await ctx.db
        .update(t)
        .set(set)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({ id: t.id, status: t.status });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await recordAudit(ctx, {
        action: "webhook.updated",
        target: { type: "webhook", id: row.id },
        metadata: set,
      });
      return { id: row.id, enabled: toEnabled(row.status) };
    }),

  /**
   * Mints a new signing secret. The outgoing one keeps signing for
   * overlapHours so the receiver can switch without a gap; the new plaintext
   * exists only in this response.
   */
  rotateSecret: adminProcedure
    .input(
      z.object({
        id: z.uuid(),
        overlapHours: z.number().int().min(0).max(WEBHOOK_ROTATION_MAX_OVERLAP_HOURS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = schema.webhookEndpoints;
      const secret = generateWebhookSecret();
      const encrypted = await encryptWebhookSecret(secret, getKeyring(), {
        teamId: ctx.teamId,
        rowId: input.id,
      });
      const expiresAt = rotationOverlapEnd(
        input.overlapHours ?? WEBHOOK_ROTATION_DEFAULT_OVERLAP_HOURS,
      );
      const [row] = await ctx.db
        .update(t)
        .set(rotatedWebhookSecretColumns({ encrypted, last4: secret.slice(-4) }, expiresAt))
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({ id: t.id, url: t.url });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await recordAudit(ctx, {
        action: "webhook.secret_rotated",
        target: { type: "webhook", id: row.id },
        metadata: { url: row.url, previousSecretExpiresAt: expiresAt?.toISOString() ?? null },
      });
      return { id: row.id, secret, previousSecretExpiresAt: expiresAt };
    }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const t = schema.webhookEndpoints;
    // Hard delete; the deliveries FK cascades, removing delivery history.
    const [row] = await ctx.db
      .delete(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .returning({ id: t.id, url: t.url });
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    await recordAudit(ctx, {
      action: "webhook.deleted",
      target: { type: "webhook", id: row.id },
      metadata: { url: row.url },
    });
    return { id: row.id };
  }),

  /**
   * Enqueues a marked sample delivery. The retry worker's normal poll picks
   * up the pending row and signs/sends it like any real event.
   */
  testDelivery: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireEndpoint(ctx.db, ctx.teamId, input.id);
      if ((await recentTestDeliveries(ctx.db, ctx.teamId)) >= TEST_DELIVERY_PER_MINUTE) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
      }
      const messageId = `msg_${randomBytes(12).toString("base64url")}`;
      const payload = {
        type: "email.sent",
        test: true,
        created_at: new Date().toISOString(),
        data: {
          email_id: "00000000-0000-0000-0000-000000000000",
          from: "MillionSend <test@example.com>",
          to: ["delivered@example.com"],
          subject: "Test event",
        },
      };
      const [row] = await ctx.db
        .insert(schema.webhookDeliveries)
        .values({
          endpointId: input.id,
          messageId,
          eventType: "email.sent",
          payload,
        })
        .returning({ id: schema.webhookDeliveries.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Delivered synchronously: a test event whose outcome appears fifteen
      // minutes later is not a test. Bounded by the pinned client's timeout.
      const [endpoint] = await ctx.db
        .select()
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, input.id));
      if (!endpoint) throw new TRPCError({ code: "NOT_FOUND" });
      const secrets = await decryptWebhookSigningSecrets(endpoint, getKeyring());
      const payloadJson = JSON.stringify(payload);
      const headers = signWebhook(secrets, {
        msgId: messageId,
        timestamp: Math.floor(Date.now() / 1000),
        payload: payloadJson,
      });
      let responseCode: number | null = null;
      let body = "";
      let ok = false;
      if (!testPortAllowed(endpoint.url)) {
        body = "port_not_allowed";
      } else {
        try {
          const res = await postJson(endpoint.url, {
            body: payloadJson,
            headers: { ...headers, "content-type": "application/json" },
            allowLocalhost: env.WEBHOOK_ALLOW_LOCALHOST,
          });
          responseCode = res.status;
          body = res.body;
          ok = res.status >= 200 && res.status < 300;
        } catch (err) {
          // Fixed codes only: the raw socket message is a host fingerprint.
          body = postFailureCode(err);
        }
      }
      await ctx.db
        .update(schema.webhookDeliveries)
        .set({
          status: ok ? "success" : "failed",
          attempts: 1,
          lastAttemptAt: new Date(),
          lastResponseCode: responseCode,
          lastResponseBody: body.slice(0, 1024),
          nextAttemptAt: null,
        })
        .where(eq(schema.webhookDeliveries.id, row.id));
      return { id: row.id, ok, responseCode };
    }),

  deliveries: router({
    list: teamProcedure
      .input(
        z.object({
          endpointId: z.uuid(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        await requireEndpoint(ctx.db, ctx.teamId, input.endpointId);
        const d = schema.webhookDeliveries;
        // limit + 1 answers "is there a next page" without counting the
        // endpoint's whole delivery history on every page.
        const rows = await ctx.db
          .select(deliveryListColumns)
          .from(d)
          .where(eq(d.endpointId, input.endpointId))
          .orderBy(desc(d.createdAt), desc(d.id))
          .offset(input.offset)
          .limit(input.limit + 1);
        return { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
      }),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const d = schema.webhookDeliveries;
      const t = schema.webhookEndpoints;
      const [row] = await ctx.db
        .select({
          ...deliveryListColumns,
          messageId: d.messageId,
          payload: d.payload,
          lastResponseBody: d.lastResponseBody,
          endpointId: d.endpointId,
        })
        .from(d)
        .innerJoin(t, eq(d.endpointId, t.id))
        .where(and(eq(d.id, input.id), eq(t.teamId, ctx.teamId)));
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),
  }),
});
