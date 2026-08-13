import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";

export type EmailStatus = (typeof schema.emailStatusEnum.enumValues)[number];

/** Event-driven ladder statuses — everything from "sent" upward. */
const EVENT_LADDER_FLOOR: EmailStatus = "sent";

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
 * Never overwrites an email that has already entered the event ladder.
 */
export async function transitionQueueState(
  db: Db,
  emailId: string,
  params: { from: "queued" | "queued_quota"; to: "queued" | "queued_quota" },
): Promise<boolean> {
  const t = schema.emails;
  const rows = await db.execute<{ id: string }>(sql`
    update ${t}
    set latest_status = ${params.to}
    where ${t.id} = ${emailId}
      and ${t.latestStatus} = ${params.from}
    returning id
  `);
  return firstRow<{ id: string }>(rows) !== undefined;
}

function compareStatus(a: EmailStatus, b: EmailStatus): number {
  const order = schema.emailStatusEnum.enumValues;
  return order.indexOf(a) - order.indexOf(b);
}
