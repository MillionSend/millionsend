import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { isMailLocale, type MailLocale } from "./account-mail.js";
import { findSenderDomainOwner } from "./system-mail.js";

/**
 * Claim the right to send one notification for (team, kind, period). True for
 * exactly one caller: the insert is the lock, so concurrent sweeps or several
 * surfaces detecting the same condition send it once.
 */
export async function claimNotification(
  db: Db,
  params: { teamId: string; kind: string; periodKey: string },
): Promise<boolean> {
  const rows = await db
    .insert(schema.teamNotifications)
    .values(params)
    .onConflictDoNothing()
    .returning({ teamId: schema.teamNotifications.teamId });
  return rows.length > 0;
}

/** Forget a kind's claims so the next episode notifies again. */
export async function clearNotifications(
  db: Db,
  params: { teamId: string; kind: string },
): Promise<void> {
  await db
    .delete(schema.teamNotifications)
    .where(
      and(
        eq(schema.teamNotifications.teamId, params.teamId),
        eq(schema.teamNotifications.kind, params.kind),
      ),
    );
}

export interface TeamOwner {
  email: string;
  name: string;
  /** The language to write to them in. */
  locale: MailLocale;
}

/**
 * The addresses account notifications go to. With the account-mail sender
 * given, each owner's language is read off their contact in the team that
 * holds that sender's domain — the row sign-up enrolls, whose `locale`
 * property is the one language the instance knows for a person outside a
 * request. Owners without one, or an instance where no team holds the
 * sender, read English.
 */
export async function listTeamOwners(
  db: Db,
  teamId: string,
  accountMailFrom?: string | null,
): Promise<TeamOwner[]> {
  const home = accountMailFrom ? await findSenderDomainOwner(db, accountMailFrom) : null;
  const c = schema.contacts;
  const rows = await db
    .select({
      email: schema.user.email,
      name: schema.user.name,
      locale: home
        ? sql<
            string | null
          >`(select ${c.properties}->>'locale' from ${c} where ${c.teamId} = ${home.teamId} and lower(${c.email}) = lower(${schema.user.email}) limit 1)`
        : sql<string | null>`null`,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "owner")));
  return rows.map((row) => ({
    email: row.email,
    name: row.name,
    locale: isMailLocale(row.locale) ? row.locale : "en",
  }));
}
