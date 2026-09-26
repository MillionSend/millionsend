import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { isMailLocale, type MailLocale } from "./account-mail.js";
import { mailPreferenceOf } from "./mail-preferences.js";
import { findSenderDomainOwner, type SystemMailKind } from "./system-mail.js";

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
 * The addresses account notifications go to, each in the owner's own
 * language: `user.locale`, which sign-up and the language switcher write.
 * Accounts from before that column fall back to the `locale` property of
 * their contact in the team holding the account-mail sender's domain (the
 * row sign-up enrolls), then to English. With the kind given, an owner who
 * turned that notice off is left out; mail that is always sent names no switch.
 */
export async function listTeamOwners(
  db: Db,
  teamId: string,
  accountMailFrom?: string | null,
  kind?: SystemMailKind,
): Promise<TeamOwner[]> {
  const home = accountMailFrom ? await findSenderDomainOwner(db, accountMailFrom) : null;
  const preference = kind ? mailPreferenceOf(kind) : null;
  const c = schema.contacts;
  const rows = await db
    .select({
      email: schema.user.email,
      name: schema.user.name,
      locale: home
        ? sql<
            string | null
          >`coalesce(${schema.user.locale}, (select ${c.properties}->>'locale' from ${c} where ${c.teamId} = ${home.teamId} and lower(${c.email}) = lower(${schema.user.email}) limit 1))`
        : schema.user.locale,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .where(
      and(
        eq(schema.teamMembers.teamId, teamId),
        eq(schema.teamMembers.role, "owner"),
        preference ? sql`not (${schema.user.mailOptOuts} ? ${preference})` : undefined,
      ),
    );
  return rows.map((row) => ({
    email: row.email,
    name: row.name,
    locale: isMailLocale(row.locale) ? row.locale : "en",
  }));
}

/**
 * The language the instance knows for one address, read the same way;
 * `fallback` when it knows none — the caller's request language, where
 * there is a request.
 */
export async function accountLocale(
  db: Db,
  accountMailFrom: string | null | undefined,
  email: string,
  fallback: MailLocale = "en",
): Promise<MailLocale> {
  const u = schema.user;
  const [account] = await db
    .select({ locale: u.locale })
    .from(u)
    // Better Auth stores addresses lowercased; an exact match keeps the unique index.
    .where(eq(u.email, email.toLowerCase()))
    .limit(1);
  if (isMailLocale(account?.locale)) return account.locale;
  const home = accountMailFrom ? await findSenderDomainOwner(db, accountMailFrom) : null;
  if (!home) return fallback;
  const c = schema.contacts;
  const [row] = await db
    .select({ locale: sql<string | null>`${c.properties}->>'locale'` })
    .from(c)
    .where(and(eq(c.teamId, home.teamId), sql`lower(${c.email}) = lower(${email})`))
    .limit(1);
  return isMailLocale(row?.locale) ? row.locale : fallback;
}
