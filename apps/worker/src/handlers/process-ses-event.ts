import {
  applyStatusCas,
  bumpHourlyUsage,
  DAY_MS,
  type EmailStatus,
  emitSuppressionEvents,
  enqueueWebhookDeliveries,
  failedEmailExtras,
  hashRecipient,
  INACTIVE_MAILBOX_PATTERN,
  isWebhookEventType,
  MAILBOX_FULL_PATTERN,
  noteConsoleCodeUndelivered,
  revokeSuppressedConfirmations,
  type SuppressionEventRow,
  sesAttempted,
  utcDay,
  type WebhookEnqueue,
  webhookBatch,
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
  if (event.eventType === "Reject") return failedEmailExtras("ses_Reject");
  return {};
}

export async function processSesEvent(
  db: Db,
  event: SerializedSesEvent,
  opts: {
    snsMessageId?: string;
    /** Arms the webhook drain for the rows written; absent, the reconcile sweep sends them. */
    enqueueWebhookDelivery?: WebhookEnqueue;
  } = {},
): Promise<void> {
  const status = STATUS_BY_EVENT[event.eventType];
  const eventType = EVENT_TYPE_BY_EVENT[event.eventType];
  if (!status || !eventType) return;

  let [email] = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      contactId: schema.emails.contactId,
      from: schema.emails.from,
      to: schema.emails.to,
      cc: schema.emails.cc,
      bcc: schema.emails.bcc,
      subject: schema.emails.subject,
      tags: schema.emails.tags,
      matchedByTag: sql<boolean>`false`,
    })
    .from(schema.emails)
    .where(eq(schema.emails.sesMessageId, event.sesMessageId));
  if (!email && event.emailId && isUuid(event.emailId)) {
    [email] = await db
      .select({
        id: schema.emails.id,
        teamId: schema.emails.teamId,
        contactId: schema.emails.contactId,
        from: schema.emails.from,
        to: schema.emails.to,
        cc: schema.emails.cc,
        bcc: schema.emails.bcc,
        subject: schema.emails.subject,
        tags: schema.emails.tags,
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
  const hooks = webhookBatch(opts.enqueueWebhookDelivery);
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
        bounceType: event.eventType === "Bounce" ? (event.bounce?.bounceType ?? null) : null,
        data: event.data,
      })
      .onConflictDoNothing()
      .returning({ id: schema.emailEvents.id });
    if (!inserted) return false;

    const flipped = await applyStatusCas(txDb, email.id, status);
    if (status === "bounced" || status === "failed") {
      await noteConsoleCodeUndelivered(txDb, email);
    }

    // Fan the now-recorded event out to the team's webhook endpoints —
    // delivery rows join the transaction; the queue enqueue happens after
    // commit (a lost job is recovered by the webhook reconcile sweep).
    // "sent" is excluded here: the send worker already fires email.sent at
    // claim time, and the SES Send event would duplicate it. email.failed
    // fires only for the event that failed the row: SES can repeat a Reject
    // under a new SNS id, which the gate above lets through.
    const webhookType = `email.${eventType}`;
    if (
      eventType !== "sent" &&
      isWebhookEventType(webhookType) &&
      (webhookType !== "email.failed" || flipped)
    ) {
      await enqueueWebhookDeliveries(txDb, {
        teamId: email.teamId,
        email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
        type: webhookType,
        occurredAt: new Date(event.occurredAt),
        extras: webhookExtras(event),
        enqueue: hooks.collect,
      });
    }

    const day = utcDay(new Date(event.occurredAt));
    // delivered and bounced count every event. Engagement counters
    // (opened/clicked) are owned by the app-layer tracking endpoints, not here.
    // hard_bounced counts only Permanent bounces — the deliverability score's
    // bounce-rate input (transient greylisting must not read as a hard-bounce
    // crisis) — and, like complained, only those about mail SES attempted, as
    // SES's own rates do.
    const cols =
      event.eventType === "Delivery"
        ? ["delivered"]
        : event.eventType === "Bounce"
          ? event.bounce?.bounceType === "Permanent" && sesAttempted(event.bounce.bounceSubType)
            ? ["bounced", "hard_bounced"]
            : ["bounced"]
          : event.eventType === "Complaint" && sesAttempted(event.complaint?.complaintSubType)
            ? ["complained"]
            : [];
    if (cols.length > 0) {
      await txDb.execute(sql`
        insert into ${schema.usageCounters} (team_id, day, ${sql.raw(cols.join(", "))})
        values (${email.teamId}, ${day}, ${sql.raw(cols.map(() => "1").join(", "))})
        on conflict (team_id, day) do update
          set ${sql.join(
            cols.map((col) => sql`${sql.raw(col)} = ${schema.usageCounters}.${sql.raw(col)} + 1`),
            sql`, `,
          )}
      `);
      await bumpHourlyUsage(txDb, {
        teamId: email.teamId,
        at: new Date(event.occurredAt),
        counts: Object.fromEntries(cols.map((col) => [col, 1])),
      });
    }

    // Auto-suppression: permanent bounces, full or abandoned mailboxes (as
    // hard bounces, see fullMailboxes) and complaints, scoped to the owning
    // team only and to addresses the email was actually sent to — the event
    // payload never gets to name who is suppressed.
    const ownRecipients = new Set(
      [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])].map(hashRecipient),
    );
    const own = (recipients: readonly string[]) =>
      recipients.filter((r) => ownRecipients.has(hashRecipient(r)));
    const toSuppress =
      event.eventType === "Bounce" && event.bounce
        ? (event.bounce.bounceType === "Permanent"
            ? own(event.bounce.recipients)
            : await fullMailboxes(
                txDb,
                email,
                event.bounce,
                own(event.bounce.recipients),
                new Date(event.occurredAt),
              )
          ).map((r) => ({ email: r, reason: "hard_bounce" as const }))
        : event.eventType === "Complaint"
          ? own(event.complaint?.recipients ?? []).map((r) => ({
              email: r,
              reason: "complaint" as const,
            }))
          : [];
    const suppressedRows: SuppressionEventRow[] = [];
    for (const s of toSuppress) {
      const [inserted] = await txDb
        .insert(schema.suppressions)
        .values({
          teamId: email.teamId,
          email: s.email,
          emailHash: hashRecipient(s.email),
          reason: s.reason,
          sourceEmailId: email.id,
        })
        .onConflictDoNothing()
        .returning({
          id: schema.suppressions.id,
          email: schema.suppressions.email,
          reason: schema.suppressions.reason,
          sourceEmailId: schema.suppressions.sourceEmailId,
          createdAt: schema.suppressions.createdAt,
        });
      if (inserted) suppressedRows.push(inserted);
    }
    await revokeSuppressedConfirmations(
      txDb,
      email.teamId,
      toSuppress.map((s) => s.email),
    );
    // New suppressions publish like the email event: rows join this
    // transaction, the queue sends happen after commit.
    if (suppressedRows.length > 0) {
      await emitSuppressionEvents(txDb, {
        teamId: email.teamId,
        type: "suppression.added",
        rows: suppressedRows,
        enqueue: hooks.collect,
      });
    }
    return true;
  });
  if (!applied) return;
  await hooks.flush();
}

/**
 * The recipients a soft bounce gives up on. An answer naming an abandoned
 * mailbox gives up at once. A full one gives up on a contact whose first
 * "full" answer came a day to 30 days before this one; with none, or one
 * older than that, this answer becomes the first, and one under a day old
 * stays first, so a mailbox answering "full" every hour still reaches the
 * day. Anyone not a contact is only given up on as abandoned. Times are the
 * bounces' own, so a late or reordered event neither stretches nor shrinks
 * the gap.
 */
async function fullMailboxes(
  db: Db,
  email: { teamId: string; contactId: string | null },
  bounce: NonNullable<SerializedSesEvent["bounce"]>,
  recipients: string[],
  at: Date,
): Promise<string[]> {
  const answer = `${bounce.bounceSubType} ${bounce.diagnosticCode ?? ""}`;
  if (bounce.bounceType !== "Transient" || !MAILBOX_FULL_PATTERN.test(answer)) return [];
  if (INACTIVE_MAILBOX_PATTERN.test(answer)) return recipients;
  const c = schema.contacts;
  const out: string[] = [];
  for (const recipient of recipients) {
    const [contact] = await db
      .select({ id: c.id, mailboxFullAt: c.mailboxFullAt })
      .from(c)
      .where(
        and(
          eq(c.teamId, email.teamId),
          email.contactId
            ? eq(c.id, email.contactId)
            : sql`lower(${c.email}) = lower(${recipient})`,
        ),
      );
    if (!contact) continue;
    const age = contact.mailboxFullAt ? at.getTime() - contact.mailboxFullAt.getTime() : null;
    if (age !== null && age >= DAY_MS && age <= 30 * DAY_MS) {
      out.push(recipient);
    } else if (age === null || age > 30 * DAY_MS) {
      await db.update(c).set({ mailboxFullAt: at }).where(eq(c.id, contact.id));
    }
  }
  return out;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
