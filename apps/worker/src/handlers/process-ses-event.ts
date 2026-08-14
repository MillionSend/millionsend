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
import { eq, sql } from "drizzle-orm";

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
  // completed, so a duplicate SNS MessageId stops here — before counters,
  // which are the one non-idempotent step below.
  const inserted = await db
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
  if (inserted.length === 0) return;

  await applyStatusCas(db, email.id, status);

  // Fan the now-recorded event out to the team's webhook endpoints. The
  // event insert above is the single idempotency gate, so this runs at most
  // once per SES event. "sent" is excluded here: the send worker already
  // fires email.sent at claim time, and the SES Send event would duplicate it.
  const webhookType = `email.${eventType}`;
  if (opts.enqueueWebhookDelivery && eventType !== "sent" && isWebhookEventType(webhookType)) {
    await enqueueWebhookDeliveries(db, {
      teamId: email.teamId,
      email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
      type: webhookType,
      occurredAt: new Date(event.occurredAt),
      extras: webhookExtras(event),
      enqueue: opts.enqueueWebhookDelivery,
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
          : null;
  if (counter) {
    await db.execute(sql`
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
    await db
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
}
