import {
  applyStatusCas,
  type EmailStatus,
  enqueueWebhookDeliveries,
  hashRecipient,
  isWebhookEventType,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

/**
 * Turns a VERIFIED SES event into state. Authority rules: the email row is
 * located by the server-recorded sesMessageId, with a server-owned SES tag as
 * a narrow fallback for the race before that MessageId is persisted;
 * recipients to suppress come from the event but are only ever suppressed
 * for the team that owns that email row.
 */

/**
 * Open and Click are deliberately absent: engagement is tracked app-layer (we
 * rewrite links and inject the pixel ourselves, generating the opened/clicked
 * events and counters at the redirect endpoints), and the per-domain config set
 * no longer subscribes to OPEN/CLICK. A stray legacy OPEN/CLICK event therefore
 * finds no mapping here and is ignored entirely — never double-counting the
 * app-layer engagement. Send is absent for the same reason: the worker records
 * the authoritative "sent" event locally at send time, so SES's Send (still
 * emitted by event destinations created before it was dropped from
 * SES_EVENT_TYPES) would only duplicate it.
 */
const STATUS_BY_EVENT: Record<string, EmailStatus | undefined> = {
  Delivery: "delivered",
  DeliveryDelay: "delivery_delayed",
  Bounce: "bounced",
  Complaint: "complained",
  Reject: "failed",
  "Rendering Failure": "failed",
};

const EVENT_TYPE_BY_EVENT: Record<
  string,
  (typeof schema.emailEventTypeEnum.enumValues)[number] | undefined
> = {
  Delivery: "delivered",
  DeliveryDelay: "delivery_delayed",
  Bounce: "bounced",
  Complaint: "complained",
  Reject: "failed",
  "Rendering Failure": "rendering_failure",
};

/** Event-specific payload fields, mirroring Resend's webhook data shapes. */
function webhookExtras(event: SerializedSesEvent): Record<string, unknown> {
  if (event.bounce) {
    return {
      bounce: {
        type: event.bounce.bounceType,
        sub_type: event.bounce.bounceSubType,
        ...(event.bounce.diagnosticCode ? { diagnostic_code: event.bounce.diagnosticCode } : {}),
      },
    };
  }
  if (event.complaint) {
    return event.complaint.complaintFeedbackType
      ? { complaint_feedback_type: event.complaint.complaintFeedbackType }
      : {};
  }
  return {};
}

export async function processSesEvent(
  db: Db,
  event: SerializedSesEvent,
  opts: {
    snsMessageId?: string;
    /** Enqueue a webhook.deliver job; deliveries are skipped when absent. */
    enqueueWebhookDelivery?: (deliveryId: string) => Promise<void>;
  } = {},
): Promise<void> {
  const status = STATUS_BY_EVENT[event.eventType];
  const eventType = EVENT_TYPE_BY_EVENT[event.eventType];
  if (!status || !eventType) return;

  let [email] = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      from: schema.emails.from,
      to: schema.emails.to,
      cc: schema.emails.cc,
      bcc: schema.emails.bcc,
      subject: schema.emails.subject,
      matchedByTag: sql<boolean>`false`,
    })
    .from(schema.emails)
    .where(eq(schema.emails.sesMessageId, event.sesMessageId));
  if (!email && event.emailId && isUuid(event.emailId)) {
    [email] = await db
      .select({
        id: schema.emails.id,
        teamId: schema.emails.teamId,
        from: schema.emails.from,
        to: schema.emails.to,
        cc: schema.emails.cc,
        bcc: schema.emails.bcc,
        subject: schema.emails.subject,
        matchedByTag: sql<boolean>`true`,
      })
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.id, event.emailId),
          isNull(schema.emails.sesMessageId),
          isNotNull(schema.emails.sentAt),
        ),
      );
  }
  // Unknown message id: not ours (or purged) — never act on it.
  if (!email) return;

  // The event insert doubles as the idempotency gate: SNS delivers
  // at-least-once and queue dedupe cannot cover redelivery after the job
  // completed, so a duplicate SNS MessageId stops at the insert. The gate
  // and every effect it guards (status CAS, counters, suppressions, webhook
  // delivery rows) commit in ONE transaction — a gate committed without its
  // effects would make a retry early-return and permanently drop them,
  // losing e.g. a hard-bounce suppression.
  const deliveryIds: string[] = [];
  const applied = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    if (email.matchedByTag) {
      const [joined] = await txDb
        .update(schema.emails)
        .set({ sesMessageId: event.sesMessageId })
        .where(
          and(
            eq(schema.emails.id, email.id),
            isNotNull(schema.emails.sentAt),
            or(
              isNull(schema.emails.sesMessageId),
              eq(schema.emails.sesMessageId, event.sesMessageId),
            ),
          ),
        )
        .returning({ id: schema.emails.id });
      if (!joined) return false;
    }
    const [inserted] = await txDb
      .insert(schema.emailEvents)
      .values({
        emailId: email.id,
        type: eventType,
        occurredAt: new Date(event.occurredAt),
        snsMessageId: opts.snsMessageId ?? null,
        data: event.data,
      })
      .onConflictDoNothing()
      .returning({ id: schema.emailEvents.id });
    if (!inserted) return false;

    await applyStatusCas(txDb, email.id, status);

    // Fan the now-recorded event out to the team's webhook endpoints —
    // delivery rows join the transaction; the queue enqueue happens after
    // commit (a lost job is recovered by the webhook reconcile sweep).
    // "sent" is excluded here: the send worker already fires email.sent at
    // claim time, and the SES Send event would duplicate it.
    const webhookType = `email.${eventType}`;
    if (opts.enqueueWebhookDelivery && eventType !== "sent" && isWebhookEventType(webhookType)) {
      await enqueueWebhookDeliveries(txDb, {
        teamId: email.teamId,
        email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
        type: webhookType,
        occurredAt: new Date(event.occurredAt),
        extras: webhookExtras(event),
        enqueue: async (deliveryId) => {
          deliveryIds.push(deliveryId);
        },
      });
    }

    const day = utcDay(new Date(event.occurredAt));
    // delivered/bounced/complained count every event. Engagement counters
    // (opened/clicked) are owned by the app-layer tracking endpoints, not here.
    const counter =
      event.eventType === "Delivery"
        ? "delivered"
        : event.eventType === "Bounce"
          ? "bounced"
          : event.eventType === "Complaint"
            ? "complained"
            : null;
    if (counter) {
      // bounced counts every bounce event; hard_bounced only Permanent ones —
      // the deliverability score's bounce-rate input (transient greylisting
      // must not read as a hard-bounce crisis).
      const cols =
        counter === "bounced" && event.bounce?.bounceType === "Permanent"
          ? [counter, "hard_bounced"]
          : [counter];
      await txDb.execute(sql`
        insert into ${schema.usageCounters} (team_id, day, ${sql.raw(cols.join(", "))})
        values (${email.teamId}, ${day}, ${sql.raw(cols.map(() => "1").join(", "))})
        on conflict (team_id, day) do update
          set ${sql.join(
            cols.map((col) => sql`${sql.raw(col)} = ${schema.usageCounters}.${sql.raw(col)} + 1`),
            sql`, `,
          )}
      `);
    }

    // Auto-suppression: permanent bounces and complaints, scoped to the
    // owning team only and to addresses the email was actually sent to —
    // the event payload never gets to name who is suppressed.
    const ownRecipients = new Set(
      [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])].map(hashRecipient),
    );
    const toSuppress = (
      event.eventType === "Bounce" && event.bounce?.bounceType === "Permanent"
        ? event.bounce.recipients.map((r) => ({ email: r, reason: "hard_bounce" as const }))
        : event.eventType === "Complaint"
          ? (event.complaint?.recipients ?? []).map((r) => ({
              email: r,
              reason: "complaint" as const,
            }))
          : []
    ).filter((s) => ownRecipients.has(hashRecipient(s.email)));
    for (const s of toSuppress) {
      await txDb
        .insert(schema.suppressions)
        .values({
          teamId: email.teamId,
          email: s.email,
          emailHash: hashRecipient(s.email),
          reason: s.reason,
          sourceEmailId: email.id,
        })
        .onConflictDoNothing();
    }
    return true;
  });
  if (!applied) return;

  const enqueueDelivery = opts.enqueueWebhookDelivery;
  if (enqueueDelivery) {
    for (const deliveryId of deliveryIds) {
      try {
        await enqueueDelivery(deliveryId);
      } catch (err) {
        console.error("webhook.deliver enqueue failed; reconcile sweep will recover", err);
      }
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
