import { applyStatusCas, type EmailStatus, hashRecipient } from "@millionsend/core";
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

export async function processSesEvent(
  db: Db,
  event: SerializedSesEvent,
  opts: { snsMessageId?: string } = {},
): Promise<void> {
  const status = STATUS_BY_EVENT[event.eventType];
  const eventType = EVENT_TYPE_BY_EVENT[event.eventType];
  if (!status || !eventType) return;

  const [email] = await db
    .select({ id: schema.emails.id, teamId: schema.emails.teamId })
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

  const day = new Date(event.occurredAt).toISOString().slice(0, 10);
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
