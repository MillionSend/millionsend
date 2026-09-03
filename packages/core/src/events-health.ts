import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, gte, isNotNull, lte, sql } from "drizzle-orm";

const WINDOW_MS = 2 * 60 * 60 * 1000;
/** A send this fresh may not have a delivery or bounce back yet; it is not judged. */
const SEND_LAG_MS = 10 * 60 * 1000;

export interface SesEventsHealth {
  /** idle = no sends old enough to judge; unhealthy = sends went out but nothing came back from SES. */
  status: "healthy" | "unhealthy" | "idle";
  sentInWindow: number;
  lastSesEventAt: Date | null;
}

/**
 * Whether SES events are reaching the instance. Rows carrying an SNS message
 * id are exactly the SES-originated ones, so "sends old enough for a delivery
 * or bounce to have come back, and none did" means the pipeline is broken —
 * no SNS subscription, one pending confirmation, or an SQS queue nobody reads.
 * Env vars being set says nothing about that; the dashboard would otherwise
 * sit at "Sent" forever.
 */
export async function sesEventsHealth(db: Db, now = new Date()): Promise<SesEventsHealth> {
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const judgeBefore = new Date(now.getTime() - SEND_LAG_MS);
  const [sent] = await db
    .select({ n: count() })
    .from(schema.emails)
    .where(and(gte(schema.emails.sentAt, windowStart), lte(schema.emails.sentAt, judgeBefore)));
  const [events] = await db
    .select({
      inWindow: sql<number>`count(*) filter (where ${schema.emailEvents.createdAt} >= ${windowStart})::int`,
      last: sql<string | null>`max(${schema.emailEvents.createdAt})`,
    })
    .from(schema.emailEvents)
    .where(isNotNull(schema.emailEvents.snsMessageId));
  const sentInWindow = sent?.n ?? 0;
  const lastSesEventAt = events?.last ? new Date(events.last) : null;
  const status =
    sentInWindow === 0 ? "idle" : (events?.inWindow ?? 0) > 0 ? "healthy" : "unhealthy";
  return { status, sentInWindow, lastSesEventAt };
}
