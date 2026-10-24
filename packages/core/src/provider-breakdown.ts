import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import {
  firstRecipientDomain,
  firstRecipientReportsComplaints,
  mailboxProviderSql,
} from "./mailbox-provider-sql.js";
import type { MailboxProvider } from "./mailbox-providers.js";
import { complaintFilter, hardBounceFilter } from "./platform-breaker.js";

/** One mailbox provider's share of a broadcast: each count is of emails, not events. */
export interface ProviderBreakdownRow {
  provider: MailboxProvider;
  sent: number;
  delivered: number;
  /** Opened by a person: a machine's prefetch is its own event type and never counts. */
  opened: number;
  clicked: number;
  /** Permanent bounces only. */
  bounced: number;
  /** Had at least one delivery delay. */
  delayed: number;
  complained: number;
  /** Sent to a provider that reports complaints: the complaint rate's denominator, zero for Gmail and Apple. */
  complaintSent: number;
}

/**
 * A broadcast's sends per recipient mailbox provider, live from its email
 * rows and their events, busiest provider first. Rows past the metadata
 * retention window are gone, and so are their counts.
 */
export async function broadcastProviderBreakdown(
  db: Db,
  p: { teamId: string; broadcastId: string },
): Promise<ProviderBreakdownRow[]> {
  const e = schema.emails;
  const ev = schema.emailEvents;
  // Nested: a single-table select writes the columns it holds directly
  // unqualified, and a bare "id" in the subquery would be the event's own.
  const ofEmail = sql`${ev.emailId} = ${e.id}`;
  const had = (event: SQL) =>
    sql<number>`count(*) filter (where exists (select 1 from ${ev} where ${ofEmail} and ${event}))::int`;
  return (
    db
      .select({
        provider: mailboxProviderSql(firstRecipientDomain),
        sent: sql<number>`count(*)::int`,
        delivered: had(sql`${ev.type} = 'delivered'`),
        opened: had(sql`${ev.type} = 'opened'`),
        clicked: had(sql`${ev.type} = 'clicked'`),
        bounced: had(hardBounceFilter),
        delayed: had(sql`${ev.type} = 'delivery_delayed'`),
        complained: had(complaintFilter),
        complaintSent: sql<number>`count(*) filter (where ${firstRecipientReportsComplaints})::int`,
      })
      .from(e)
      .where(
        and(
          eq(e.teamId, p.teamId),
          eq(e.broadcastId, p.broadcastId),
          isNotNull(e.sentAt),
          // SES refused it outright: the claim stays but nothing went out.
          ne(e.latestStatus, "failed"),
        ),
      )
      // By position: the provider expression binds its lists as parameters,
      // and bound again it would read as a different expression.
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`), sql`1`)
  );
}
