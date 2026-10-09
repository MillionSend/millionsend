import { CONTENT_REVEAL_FIELDS, CONTENT_REVEAL_NOTICE_DAYS } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

export interface RevealNoticeDeps {
  now?: Date | undefined;
}

/**
 * The disclosure side of break-glass content access: seven days after a
 * grant, the team's own audit gains a `content.accessed` row dated at the
 * access. Nobody is emailed, then or ever.
 *
 * Withheld for good from a team suspended for phishing — telling the account
 * under investigation what was read, and when, is the one case where
 * disclosure works against the reason the content was read at all; the grant
 * is stamped so it is not retried every night. A team held for review waits
 * unstamped: the first run after the hold ends writes the row, or withholds
 * it if the hold became a phishing suspension.
 */
export async function runRevealNotices(
  db: Db,
  deps: RevealNoticeDeps = {},
): Promise<{ disclosed: number; withheld: number }> {
  const now = deps.now ?? new Date();
  const due = new Date(now.getTime() - CONTENT_REVEAL_NOTICE_DAYS * 86_400_000);
  const g = schema.contentAccessGrants;
  const t = schema.teams;
  const grants = await db
    .select({
      id: g.id,
      teamId: g.teamId,
      reason: g.reason,
      emailIds: g.emailIds,
      createdAt: g.createdAt,
      suspendedAt: t.suspendedAt,
      suspensionReason: t.suspensionReason,
    })
    .from(g)
    .innerJoin(t, eq(t.id, g.teamId))
    .where(
      and(
        isNull(g.noticeSentAt),
        lte(g.createdAt, due),
        // Filtered here, not skipped below: a long hold's grants must not
        // fill the batch ahead of every other team's.
        or(isNull(t.suspendedAt), sql`${t.suspensionReason} is distinct from 'review'`),
      ),
    )
    .orderBy(g.createdAt)
    .limit(200);

  let disclosed = 0;
  let withheld = 0;
  for (const grant of grants) {
    // Suspended for phishing at the disclosure, whenever that happened: a
    // re-suspension keeps the original suspended_at, so an escalation to
    // phishing would otherwise read as older than the grant, and a team
    // already suspended for it is no less under investigation.
    const underInvestigation = grant.suspensionReason === "phishing" && grant.suspendedAt !== null;
    try {
      if (!underInvestigation) {
        // Written straight rather than through recordAudit, whose failures are
        // swallowed so a trail can never fail the action it records: here the
        // row IS the action, so a failed write must leave the grant unstamped
        // for tomorrow's run. Dated at the access, not at the disclosure.
        await db.insert(schema.auditLog).values({
          teamId: grant.teamId,
          actorId: "system",
          action: "content.accessed",
          target: `content_access_grant:${grant.id}`,
          data: {
            reason: grant.reason,
            emails: grant.emailIds.length,
            fields: CONTENT_REVEAL_FIELDS,
          },
          createdAt: grant.createdAt,
        });
      }
      await db
        .update(g)
        .set({
          noticeSentAt: now,
          ...(underInvestigation ? {} : { teamVisibleAt: now }),
        })
        .where(and(eq(g.id, grant.id), isNull(g.noticeSentAt)));
      if (underInvestigation) withheld += 1;
      else disclosed += 1;
    } catch (err) {
      console.error(`safety.reveal_notices: grant ${grant.id} failed`, err);
    }
  }
  return { disclosed, withheld };
}
