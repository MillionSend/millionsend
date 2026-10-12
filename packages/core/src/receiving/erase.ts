import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { type InboxActor, recordInboxActivity } from "../inboxes/activity.js";
import { auditActorOf } from "../inboxes/inbox-common.js";

/**
 * Threads left with nothing in them: no received or sent message and no
 * unsent draft. Called where messages go (an erase, the retention purges).
 */
export async function deleteEmptyThreads(db: Db, threadIds?: readonly string[]): Promise<number> {
  if (threadIds && threadIds.length === 0) return 0;
  const t = schema.inboxThreads;
  const m = schema.receivedEmailInboxes;
  const e = schema.emails;
  const d = schema.inboxDrafts;
  const deleted = await db
    .delete(t)
    .where(
      and(
        threadIds ? inArray(t.id, [...threadIds]) : undefined,
        sql`not exists (select 1 from ${m} where ${m.threadId} = ${t.id})`,
        sql`not exists (select 1 from ${e} where ${e.threadId} = ${t.id})`,
        sql`not exists (select 1 from ${d} where ${d.threadId} = ${t.id} and ${d.status} in ('draft', 'pending_approval'))`,
      ),
    )
    .returning({ id: t.id });
  return deleted.length;
}

/**
 * Erases one received email now: the row with its sealed content, its
 * inbox memberships and its received secrets (they cascade), and threads it
 * leaves empty. Webhook payloads keep their metadata-only copies until the
 * payload strip. False when the team has no such row.
 */
export async function deleteReceivedEmail(
  db: Db,
  p: { teamId: string; id: string; actor: InboxActor },
): Promise<boolean> {
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const deleted = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const memberships = await tx
      .select({ inboxId: m.inboxId, threadId: m.threadId })
      .from(m)
      .where(and(eq(m.receivedEmailId, p.id), eq(m.teamId, p.teamId)));
    const [row] = await tx
      .delete(r)
      .where(and(eq(r.id, p.id), eq(r.teamId, p.teamId)))
      .returning({ id: r.id });
    if (!row) return false;
    await deleteEmptyThreads(
      tx,
      memberships.map((x) => x.threadId),
    );
    for (const membership of memberships) {
      await recordInboxActivity(tx, {
        teamId: p.teamId,
        inboxId: membership.inboxId,
        actor: p.actor,
        action: "email.deleted",
        emailId: p.id,
      });
    }
    return true;
  });
  if (deleted) {
    const { actor, metadata } = auditActorOf(p.actor);
    await recordAudit(db, {
      teamId: p.teamId,
      actor,
      action: "received_email.deleted",
      target: { type: "received_email", id: p.id },
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }
  return deleted;
}
