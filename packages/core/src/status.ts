import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type SQL, sql } from "drizzle-orm";
import { firstRow, resultRows } from "./driver-result.js";
import { complaintFilter } from "./platform-breaker.js";
import {
  type EmailWebhookEvent,
  enqueueEmailWebhookEvents,
  failedEmailExtras,
  suppressedEmailExtras,
  type WebhookEnqueue,
} from "./webhooks.js";

export type EmailStatus = (typeof schema.emailStatusEnum.enumValues)[number];

/** Event-driven ladder statuses — everything from "sent" upward. */
const EVENT_LADDER_FLOOR: EmailStatus = "sent";

const emails = schema.emails;
const events = schema.emailEvents;

/**
 * Over emails: a recipient who had the email complained about it. SES also
 * raises a complaint about mail it never attempted (sesAttempted), which
 * lifts the status to complained all the same, so the status alone is not
 * enough: the email needs a complaint complaintFilter counts.
 */
export const complainedEmail = sql`(${emails.latestStatus} = 'complained' and exists (select 1 from ${events} where ${events.emailId} = ${emails.id} and ${complaintFilter}))`;

/**
 * Over emails: the email reached the inbox. An opened or clicked one was
 * necessarily delivered, and so was one its recipient complained about,
 * though that rung sits above the bounces.
 */
export const deliveredEmail = sql`(${emails.latestStatus} in ('delivered', 'opened', 'clicked') or ${complainedEmail})`;

/**
 * Highest-rank-wins compare-and-set on emails.latest_status, leaning on
 * Postgres's native enum ordering (declaration order = comparison order).
 * Applies ONLY to event-driven statuses ("sent" and above): queue-internal
 * states (queued_quota/queued) sit below the ladder and move via
 * transitionQueueState — the CAS could never reach them (the column default
 * "queued" already outranks "queued_quota"). Returns whether the update applied.
 */
export async function applyStatusCas(db: Db, emailId: string, next: EmailStatus): Promise<boolean> {
  const t = schema.emails;
  if (compareStatus(next, EVENT_LADDER_FLOOR) < 0) {
    throw new Error(
      `applyStatusCas only accepts event statuses ("${EVENT_LADDER_FLOOR}"+); use transitionQueueState for "${next}"`,
    );
  }
  const rows = await db.execute<{ id: string }>(sql`
    update ${t}
    set latest_status = ${next}
    where ${t.id} = ${emailId}
      and ${t.latestStatus} < ${next}
    returning id
  `);
  return firstRow<{ id: string }>(rows) !== undefined;
}

/**
 * Exact-guard transition for queue-internal states (e.g. the midnight drain's
 * queued_quota → queued, or accept-time parking queued → queued_quota).
 * Never overwrites an email that has already entered the event ladder, nor
 * one a send lane has claimed (sent_at set): its quota is spent either way.
 * A row leaving the park leaves its park reason behind.
 */
export async function transitionQueueState(
  db: Db,
  emailId: string,
  params: { from: "queued" | "queued_quota"; to: "queued" | "queued_quota" },
): Promise<boolean> {
  const t = schema.emails;
  const rows = await db.execute<{ id: string }>(sql`
    update ${t}
    set latest_status = ${params.to}${params.to === "queued" ? sql`, park_reason = null` : sql``}
    where ${t.id} = ${emailId}
      and ${t.latestStatus} = ${params.from}
      and ${t.sentAt} is null
    returning id
  `);
  return firstRow<{ id: string }>(rows) !== undefined;
}

/**
 * Ends queued emails as failed or suppressed: one guarded UPDATE that also
 * writes each row's event with `data` as given, then email.<status> for
 * each team the rows belong to. It runs on the db or transaction it is
 * handed, so a caller's transaction commits the status, the events and the
 * delivery rows together; `enqueue` collects those rows for the caller to
 * hand to the queue after its commit. Returns how many rows it ended.
 *
 * The base guard leaves alone any row SES accepted (ses_message_id set):
 * the SES events own its fate, and failing it would fire email.failed for
 * mail that was delivered.
 */
export async function endQueuedEmails(
  db: Db,
  params: {
    status: "failed" | "suppressed";
    /** The site's own guard, on top of the base one. */
    where: SQL | undefined;
    data: { source?: string; reason: string };
    now: Date;
    enqueue: WebhookEnqueue;
  },
): Promise<number> {
  const t = schema.emails;
  // The events go in through INSERT ... SELECT, not one bound row each: a
  // domain's parked backlog can end in one call, past Postgres's cap of
  // 65,535 parameters a statement.
  const ended = resultRows<{
    id: string;
    teamId: string;
    from: string;
    to: string[];
    subject: string;
  }>(
    await db.execute(sql`
      with ended as (
        update ${t}
        set latest_status = ${params.status}${params.status === "failed" ? sql`, sent_at = null` : sql``}
        where ${t.latestStatus} in ('queued', 'queued_quota')
          and ${t.sesMessageId} is null
          and ${params.where ?? sql`true`}
        returning ${t.id}, ${t.teamId}, ${t.from}, ${t.to}, ${t.subject}
      ), events as (
        insert into ${schema.emailEvents} (email_id, type, occurred_at, data)
        select id, ${params.status}::email_event_type, ${params.now}::timestamptz,
          ${JSON.stringify(params.data)}::jsonb
        from ended
      )
      select id, team_id as "teamId", "from", "to", subject from ended
    `),
  );
  const extras =
    params.status === "failed"
      ? failedEmailExtras(params.data.reason)
      : suppressedEmailExtras(params.data.reason);
  const byTeam = new Map<string, EmailWebhookEvent[]>();
  for (const row of ended) {
    const events = byTeam.get(row.teamId) ?? [];
    events.push({
      type: `email.${params.status}`,
      email: { emailId: row.id, from: row.from, to: row.to, subject: row.subject },
      occurredAt: params.now,
      extras,
    });
    byTeam.set(row.teamId, events);
  }
  for (const [teamId, events] of byTeam) {
    await enqueueEmailWebhookEvents(db, { teamId, events, enqueue: params.enqueue });
  }
  return ended.length;
}

/**
 * The highest-ranked status among a row's event types, for a status that
 * is recomputed from the events left after some were reclassified. Null
 * when none of the types is a status.
 */
export function highestStatus(types: readonly string[]): EmailStatus | null {
  return schema.emailStatusEnum.enumValues.findLast((status) => types.includes(status)) ?? null;
}

function compareStatus(a: EmailStatus, b: EmailStatus): number {
  const order = schema.emailStatusEnum.enumValues;
  return order.indexOf(a) - order.indexOf(b);
}
