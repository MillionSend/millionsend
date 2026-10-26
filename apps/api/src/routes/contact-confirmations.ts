import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ContactSnapshot,
  contactEventData,
  contactRoom,
  contactSnapshotColumns,
  ERASED_TOMBSTONE,
  eraseRecipient,
  lockSuppressionContacts,
  markSegmentsStale,
  type SuppressionEventRow,
  suppressionHashesFor,
  type TeamWebhookEvent,
  undeliverableRecipients,
  webhookBatch,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type ApiDeps, type Env, errorBody } from "../app.js";
import { errorSchema } from "../schemas.js";

type Confirmation = NonNullable<typeof schema.contacts.$inferSelect.confirmation>;
const confirmationSchema = z.object({
  id: z.uuid(),
  request_id: z.uuid(),
  email: z.email(),
  requested_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "confirmed", "revoked"]),
  confirmed_at: z.string().optional(),
  revoked_at: z.string().optional(),
  withdrawn_at: z.string().optional(),
  created_contact: z.boolean(),
  resubscription: z.boolean(),
});
function wire(id: string, c: Confirmation) {
  return {
    id,
    request_id: c.requestId,
    email: c.email,
    requested_at: c.requestedAt,
    expires_at: c.expiresAt,
    status: c.state,
    confirmed_at: c.confirmedAt,
    revoked_at: c.revokedAt,
    withdrawn_at: c.withdrawnAt,
    created_contact: c.createdContact,
    resubscription: c.resubscription ?? false,
  };
}

/** Mailbox-token verification and consent evidence remain the integration's responsibility. */
export function registerContactConfirmationRoutes(app: OpenAPIHono<Env>, deps: ApiDeps) {
  const db = deps.db,
    t = schema.contacts,
    s = schema.suppressions;
  const err = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const ok = {
    content: { "application/json": { schema: confirmationSchema } },
    description: "Current confirmation request",
  };
  // Persist timeline/webhook outbox in the same transaction. Wake workers only
  // after commit; an enqueue failure is recovered by the outbox reconciler.
  async function transaction<T>(
    work: (
      tx: Db,
      emit: (
        teamId: string,
        contact: ContactSnapshot,
        types: TeamWebhookEvent["type"][],
        activity?: "contact_created" | "resubscribed",
      ) => Promise<void>,
      removed: (teamId: string, rows: SuppressionEventRow[]) => Promise<void>,
    ) => Promise<T>,
  ) {
    const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      return work(
        txDb,
        async (teamId, contact, types, activity) => {
          if (activity)
            await tx.insert(schema.contactActivities).values({
              teamId: teamId,
              contactId: contact.id,
              type: activity,
            });
          await hooks.emit(
            txDb,
            teamId,
            types.map((type) => ({
              type,
              occurredAt: new Date(),
              data: contactEventData(contact, { source: "api" }),
            })),
          );
        },
        async (teamId, rows) => {
          await hooks.emit(
            txDb,
            teamId,
            rows.map((row) => ({
              type: "suppression.removed" as const,
              occurredAt: new Date(),
              data: {
                id: row.id,
                email: row.email ?? ERASED_TOMBSTONE,
                origin: "unsubscribe",
                source: "api",
                source_id: row.sourceEmailId,
                created_at: (row.createdAt ?? new Date()).toISOString(),
              },
            })),
          );
        },
      );
    });
    await hooks.flush();
    return result;
  }
  async function suppressed(tx: Db, teamId: string, email: string) {
    return Boolean(
      (
        await tx
          .select({ id: s.id })
          .from(s)
          .where(and(eq(s.teamId, teamId), inArray(s.emailHash, suppressionHashesFor(email))))
          .limit(1)
      )[0],
    );
  }
  app.openapi(
    createRoute({
      method: "post",
      path: "/contacts/confirmation-requests",
      description:
        "Create an inactive contact with a mailbox confirmation, or replace a still-pending request. Historical contacts remain unchanged by default. Explicit allow_resubscribe stages a fresh request for an inactive contact, retaining a matching newsletter unsubscribe until confirmation. Other suppressions are never lifted.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  email: z
                    .string()
                    .trim()
                    .pipe(z.email())
                    .pipe(z.string().max(320))
                    .transform((x) => x.toLowerCase()),
                  request_id: z.uuid(),
                  allow_resubscribe: z.boolean().optional(),
                  expires_at: z.iso.datetime({ offset: true }),
                })
                .strict(),
            },
          },
        },
      },
      responses: {
        200: ok,
        409: err("Contact is not eligible"),
        422: err("Invalid expiry or address"),
        403: err("Contact plan limit reached"),
      },
    }),
    async (c) => {
      const auth = c.get("auth"),
        input = c.req.valid("json"),
        now = new Date();
      if (
        new Date(input.expires_at) <= now ||
        (await undeliverableRecipients([input.email])).length
      )
        return c.json(errorBody(422, "validation_error", "Invalid expiry or address"), 422);
      const result = await transaction(async (tx, emit) => {
        await lockSuppressionContacts(tx, auth.teamId, [input.email]);
        const where = and(eq(t.teamId, auth.teamId), sql`lower(${t.email}) = ${input.email}`);
        let [contact] = await tx.select().from(t).where(where).for("update");
        const blocks = await tx
          .select()
          .from(s)
          .where(
            and(eq(s.teamId, auth.teamId), inArray(s.emailHash, suppressionHashesFor(input.email))),
          )
          .orderBy(s.id)
          .for("update");
        if (
          blocks.length &&
          (!input.allow_resubscribe ||
            blocks.some(
              (block) =>
                block.reason !== "one_click_unsubscribe" ||
                block.email?.toLowerCase() !== input.email,
            ))
        )
          return { kind: "conflict" } as const;
        if (contact?.confirmation?.requestId === input.request_id) {
          if (
            contact.unsubscribed &&
            contact.confirmation.state === "pending" &&
            contact.confirmation.email === input.email &&
            JSON.stringify(contact.confirmation.unsubscribeSuppressionIds ?? []) ===
              JSON.stringify(blocks.map((x) => x.id))
          )
            return { kind: "ok", id: contact.id, confirmation: contact.confirmation } as const;
          return { kind: "conflict" } as const;
        }
        if (
          contact &&
          ((!contact.unsubscribed && !(input.allow_resubscribe && blocks.length)) ||
            (!input.allow_resubscribe &&
              (contact.confirmation?.state !== "pending" ||
                contact.confirmation.email !== contact.email)))
        )
          return { kind: "conflict" } as const;
        let created = false;
        const candidate: Confirmation = {
          requestId: input.request_id,
          email: input.email,
          requestedAt: now.toISOString(),
          expiresAt: new Date(input.expires_at).toISOString(),
          state: "pending",
          createdContact:
            !contact ||
            (contact.confirmation?.state === "pending" && contact.confirmation.createdContact),
          ...(contact?.confirmation?.withdrawnAt
            ? { withdrawnAt: contact.confirmation.withdrawnAt }
            : {}),
          ...(input.allow_resubscribe && (contact || blocks.length)
            ? { resubscription: true }
            : {}),
          ...(blocks.length ? { unsubscribeSuppressionIds: blocks.map((x) => x.id) } : {}),
        };
        if (!contact) {
          const room = await contactRoom(tx, auth.teamId, auth.plan, deps.isCloud);
          if (room !== null && room < 1) return { kind: "limit" } as const;
          [contact] = await tx
            .insert(t)
            .values({
              teamId: auth.teamId,
              email: input.email,
              unsubscribed: true,
              confirmation: candidate,
            })
            .onConflictDoNothing()
            .returning();
          created = Boolean(contact);
          if (!contact) {
            [contact] = await tx.select().from(t).where(where).for("update");
            candidate.createdContact = Boolean(
              contact?.confirmation?.state === "pending" && contact.confirmation.createdContact,
            );
          }
        }
        if (
          (!contact?.unsubscribed && !(input.allow_resubscribe && blocks.length)) ||
          !contact ||
          (!created &&
            !input.allow_resubscribe &&
            (contact.confirmation?.state !== "pending" ||
              contact.confirmation.email !== contact.email))
        )
          return { kind: "conflict" } as const;
        if (!created) {
          const [updated] = await tx
            .update(t)
            .set({
              confirmation: candidate,
              updatedAt: now,
              ...(blocks.length ? { unsubscribed: true } : {}),
            })
            .where(eq(t.id, contact.id))
            .returning();
          if (!updated) throw new Error("Confirmation contact disappeared");
          contact = updated;
        }
        await emit(
          auth.teamId,
          contact,
          created ? ["contact.created"] : ["contact.updated"],
          created ? "contact_created" : undefined,
        );
        return { kind: "ok", id: contact.id, confirmation: candidate } as const;
      });
      if (result.kind === "limit")
        return c.json(errorBody(403, "plan_limit_reached", "Contact plan limit reached"), 403);
      if (result.kind === "conflict")
        return c.json(
          errorBody(409, "validation_error", "Contact is not eligible for a confirmation request"),
          409,
        );
      return c.json(wire(result.id, result.confirmation), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/contacts/{id}/confirmation",
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: ok, 404: err("Confirmation not found") },
    }),
    async (c) => {
      const auth = c.get("auth"),
        id = c.req.valid("param").id;
      const [contact] = await db
        .select({ confirmation: t.confirmation })
        .from(t)
        .where(and(eq(t.id, id), eq(t.teamId, auth.teamId)));
      if (!contact?.confirmation)
        return c.json(errorBody(404, "not_found", "Confirmation not found"), 404);
      return c.json(wire(id, contact.confirmation), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/contacts/{id}/confirmation",
      description:
        "Remove only the matching revoked or expired inactive confirmation metadata, preserving the contact and every suppression.",
      request: {
        params: z.object({ id: z.uuid() }),
        query: z.object({
          request_id: z.uuid(),
          erase_contact: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ id: z.uuid(), deleted: z.literal(true) }) },
          },
          description: "Confirmation metadata removed",
        },
        404: err("Contact not found"),
        409: err("Confirmation is still in use or has changed"),
      },
    }),
    async (c) => {
      const auth = c.get("auth"),
        id = c.req.valid("param").id,
        requestId = c.req.valid("query").request_id,
        eraseContact = c.req.valid("query").erase_contact === "true";
      const result = await transaction(async (tx, emit) => {
        const [contact] = await tx
          .select()
          .from(t)
          .where(and(eq(t.teamId, auth.teamId), eq(t.id, id)))
          .for("update");
        if (!contact) return "missing";
        const proof = contact.confirmation;
        if (!proof) return eraseContact ? "conflict" : "deleted";
        if (
          !contact.unsubscribed ||
          proof.requestId !== requestId ||
          !(
            proof.state === "revoked" ||
            (proof.state === "pending" && new Date(proof.expiresAt) <= new Date())
          )
        )
          return "conflict";
        if (eraseContact) {
          if (
            !proof.createdContact ||
            proof.state !== "pending" ||
            contact.firstName ||
            contact.lastName ||
            Object.keys(contact.properties).length ||
            (await suppressed(tx, auth.teamId, contact.email))
          )
            return "conflict";
          await eraseRecipient(tx, auth.teamId, contact.email);
          await tx.delete(t).where(eq(t.id, id));
          await markSegmentsStale(tx, { teamId: auth.teamId });
          await emit(
            auth.teamId,
            { ...contact, email: ERASED_TOMBSTONE, firstName: null, lastName: null },
            ["contact.deleted"],
          );
          return "deleted";
        }
        const [updated] = await tx
          .update(t)
          .set({ confirmation: null, updatedAt: new Date() })
          .where(eq(t.id, id))
          .returning(contactSnapshotColumns);
        if (updated) await emit(auth.teamId, updated, ["contact.updated"]);
        return "deleted";
      });
      if (result === "missing")
        return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      if (result === "conflict")
        return c.json(
          errorBody(409, "validation_error", "Confirmation is still in use or has changed"),
          409,
        );
      return c.json({ id, deleted: true as const }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/contacts/{id}/confirm",
      description:
        "Confirm a matching, unexpired mailbox request. Only an explicitly staged resubscription can lift the exact earlier newsletter unsubscribe captured by that request; all other suppressions remain. The authenticated integration must verify its single-use mailbox token first.",
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  request_id: z.uuid(),
                  email: z
                    .string()
                    .trim()
                    .pipe(z.email())
                    .transform((x) => x.toLowerCase()),
                  confirmed_at: z.iso.datetime({ offset: true }),
                })
                .strict(),
            },
          },
        },
      },
      responses: {
        200: ok,
        404: err("Contact not found"),
        409: err("Request changed, revoked, expired or suppressed"),
        422: err("Invalid timestamp"),
      },
    }),
    async (c) => {
      const auth = c.get("auth"),
        id = c.req.valid("param").id,
        input = c.req.valid("json"),
        now = new Date(),
        at = new Date(input.confirmed_at);
      const conflict = new Error("Confirmation changed concurrently");
      const result = await transaction(async (tx, emit, removed) => {
        await lockSuppressionContacts(tx, auth.teamId, [input.email]);
        const [contact] = await tx
          .select()
          .from(t)
          .where(and(eq(t.id, id), eq(t.teamId, auth.teamId)))
          .for("update");
        if (!contact) return { kind: "missing" } as const;
        const pending = contact.confirmation;
        if (
          !pending ||
          pending.requestId !== input.request_id ||
          pending.email !== input.email ||
          contact.email !== input.email
        )
          return { kind: "conflict" } as const;
        const blocks = await tx
          .select()
          .from(s)
          .where(
            and(eq(s.teamId, auth.teamId), inArray(s.emailHash, suppressionHashesFor(input.email))),
          )
          .orderBy(s.id)
          .for("update");
        if (
          !contact.unsubscribed &&
          pending.state === "confirmed" &&
          !blocks.length &&
          pending.confirmedAt === at.toISOString()
        )
          return { kind: "ok", confirmation: pending } as const;
        if (
          !contact.unsubscribed ||
          pending.state !== "pending" ||
          new Date(pending.expiresAt) <= now
        )
          return { kind: "conflict" } as const;
        if (at < new Date(pending.requestedAt) || at > now || at >= new Date(pending.expiresAt))
          return { kind: "invalid" } as const;
        const baseline = pending.unsubscribeSuppressionIds ?? [];
        const sameBlocks =
          pending.resubscription === true &&
          blocks.every(
            (block) =>
              block.reason === "one_click_unsubscribe" &&
              block.email?.toLowerCase() === input.email,
          ) &&
          JSON.stringify(blocks.map((x) => x.id)) === JSON.stringify(baseline);
        if ((blocks.length || baseline.length) && !sameBlocks) return { kind: "conflict" } as const;
        if (blocks.length) {
          const dropped = await tx
            .delete(s)
            .where(
              and(
                eq(s.teamId, auth.teamId),
                inArray(s.id, baseline),
                eq(s.reason, "one_click_unsubscribe"),
              ),
            )
            .returning();
          if (dropped.length !== baseline.length) throw conflict;
          await removed(auth.teamId, dropped);
        }
        const proof: Confirmation = {
          ...pending,
          state: "confirmed",
          confirmedAt: at.toISOString(),
        };
        const [updated] = await tx
          .update(t)
          .set({ unsubscribed: false, unsubscribedAt: null, updatedAt: now, confirmation: proof })
          .where(
            and(
              eq(t.id, id),
              eq(t.teamId, auth.teamId),
              eq(t.unsubscribed, true),
              sql`${t.confirmation}->>'state' = 'pending'`,
              sql`${t.confirmation}->>'requestId' = ${input.request_id}`,
              sql`not exists (select 1 from ${s} where ${s.teamId}=${auth.teamId} and ${inArray(s.emailHash, suppressionHashesFor(input.email))})`,
            ),
          )
          .returning(contactSnapshotColumns);
        if (!updated) throw conflict;
        await emit(
          auth.teamId,
          updated,
          ["contact.resubscribed", "contact.updated"],
          "resubscribed",
        );
        return { kind: "ok", confirmation: proof } as const;
      }).catch((error) => {
        if (error === conflict) return { kind: "conflict" } as const;
        throw error;
      });
      if (result.kind === "missing")
        return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      if (result.kind === "conflict")
        return c.json(
          errorBody(409, "validation_error", "Confirmation request is no longer eligible"),
          409,
        );
      if (result.kind === "invalid")
        return c.json(errorBody(422, "validation_error", "Invalid confirmation timestamp"), 422);
      return c.json(wire(id, result.confirmation), 200);
    },
  );
}
