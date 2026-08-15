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
import { and, eq, ne, sql } from "drizzle-orm";

/**
 * Turns a VERIFIED SES event into state. Authority rules: the email row is
 * located exclusively by the server-recorded sesMessageId; recipients to
 * suppress come from the event but are only ever suppressed for the team
 * that owns that email row — a forged-recipient event can never touch
 * another tenant.
 */

const STATUS_BY_EVENT: Record<string, EmailStatus | undefined> = {
  Send: "sent",
  Delivery: "delivered",
  DeliveryDelay: "delivery_delayed",
  Bounce: "bounced",
  Complaint: "complained",
  Open: "opened",
  Click: "clicked",
  Reject: "failed",
  "Rendering Failure": "failed",
};

const EVENT_TYPE_BY_EVENT: Record<
  string,
  (typeof schema.emailEventTypeEnum.enumValues)[number] | undefined
> = {
  Send: "sent",
  Delivery: "delivered",
  DeliveryDelay: "delivery_delayed",
  Bounce: "bounced",
  Complaint: "complained",
  Open: "opened",
  Click: "clicked",
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
  if (event.click?.link) return { click: { link: event.click.link } };
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

  const [email] = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      from: schema.emails.from,
      to: schema.emails.to,
      subject: schema.emails.subject,
    })
    .from(schema.emails)
    .where(eq(schema.emails.sesMessageId, event.sesMessageId));
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
    const counter =
      event.eventType === "Delivery"
        ? "delivered"
        : event.eventType === "Bounce"
          ? "bounced"
          : event.eventType === "Complaint"
            ? "complained"
            : event.eventType === "Open"
              ? "opened"
              : event.eventType === "Click"
                ? "clicked"
                : null;
    // opened/clicked aggregate UNIQUE engagement: a recipient opening five
    // times is one open, so the counter advances only on the first such event
    // for this email. delivered/bounced/complained count every event.
    const countsUnique = counter === "opened" || counter === "clicked";
    let shouldCount = counter !== null;
    if (counter && countsUnique) {
      const [prior] = await txDb
        .select({ id: schema.emailEvents.id })
        .from(schema.emailEvents)
        .where(
          and(
            eq(schema.emailEvents.emailId, email.id),
            eq(schema.emailEvents.type, eventType),
            ne(schema.emailEvents.id, inserted.id),
          ),
        )
        .limit(1);
      shouldCount = prior === undefined;
    }
    if (counter && shouldCount) {
      await txDb.execute(sql`
        insert into ${schema.usageCounters} (team_id, day, ${sql.raw(counter)})
        values (${email.teamId}, ${day}, 1)
        on conflict (team_id, day) do update
          set ${sql.raw(counter)} = ${schema.usageCounters}.${sql.raw(counter)} + 1
      `);
    }

    // Auto-suppression: permanent bounces and complaints, scoped to the
    // owning team only.
    const toSuppress =
      event.eventType === "Bounce" && event.bounce?.bounceType === "Permanent"
        ? event.bounce.recipients.map((r) => ({ email: r, reason: "hard_bounce" as const }))
        : event.eventType === "Complaint"
          ? (event.complaint?.recipients ?? []).map((r) => ({
              email: r,
              reason: "complaint" as const,
            }))
          : [];
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
