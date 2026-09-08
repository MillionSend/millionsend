import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { recordContactActivity } from "./contact-activities.js";
import { eraseRecipient } from "./erase-recipient.js";
import { splitPersonName } from "./person-name.js";
import { clearUnsubscribeSuppression } from "./suppressions.js";

/**
 * A new account becomes a contact of the team that holds the instance's
 * account mail (findSenderDomainOwner), so product updates can reach every
 * user from the same place their password resets are logged. Idempotent on
 * the team's case-insensitive address index, and never touches an existing
 * row: a contact the operator deleted stays deleted, an unsubscribed one
 * stays unsubscribed. The timeline records the creation; no webhook fires,
 * since the team did not act.
 */
export async function enrollSystemContact(
  db: Db,
  teamId: string,
  user: {
    email: string;
    name: string;
    locale?: string | undefined;
    /** How the address arrived: an account sign-up, or a confirmed opt-in. */
    source?: "signup" | "self-host" | "updates" | undefined;
  },
): Promise<string | null> {
  const t = schema.contacts;
  const [row] = await db
    .insert(t)
    .values({
      teamId,
      email: user.email,
      ...splitPersonName(user.name),
      properties: {
        source: user.source ?? "signup",
        signed_up_at: new Date().toISOString(),
        ...(user.locale ? { locale: user.locale } : {}),
      },
    })
    .onConflictDoNothing()
    .returning({ id: t.id });
  if (!row) return null;
  await recordContactActivity(db, { teamId, contactId: row.id, type: "contact_created" });
  return row.id;
}

/**
 * A confirmed opt-in (the recipient opened the emailed link): enroll, and if
 * the address already has a contact that had unsubscribed, subscribe it
 * again — the explicit consent is exactly what the dashboard's re-subscribe
 * requires, and it clears the retained one-click suppression the same way.
 */
export async function confirmSystemContact(
  db: Db,
  teamId: string,
  user: Parameters<typeof enrollSystemContact>[2],
): Promise<void> {
  if ((await enrollSystemContact(db, teamId, user)) !== null) return;
  const t = schema.contacts;
  const [resubscribed] = await db
    .update(t)
    .set({ unsubscribed: false, unsubscribedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(t.teamId, teamId),
        sql`lower(${t.email}) = ${user.email.toLowerCase()}`,
        eq(t.unsubscribed, true),
      ),
    )
    .returning({ id: t.id });
  if (!resubscribed) return;
  await clearUnsubscribeSuppression(db, teamId, user.email);
  await recordContactActivity(db, { teamId, contactId: resubscribed.id, type: "resubscribed" });
}

/**
 * The account is gone: drop its contact row in the account-mail team and
 * scrub the address from that team's history (emails, events, deliveries,
 * request log), the same erasure the dashboard's admin erase action and
 * `DELETE /contacts/{id}?erase=true` perform.
 * Suppression hashes survive, so a later do-not-contact still holds. The
 * erasure is injectable: the web tier hands it to the worker queue.
 */
export async function removeSystemContact(
  db: Db,
  teamId: string,
  email: string,
  erase: (teamId: string, address: string) => Promise<unknown> = (t, a) => eraseRecipient(db, t, a),
): Promise<void> {
  const t = schema.contacts;
  await db
    .delete(t)
    .where(and(eq(t.teamId, teamId), sql`lower(${t.email}) = ${email.toLowerCase()}`));
  await erase(teamId, email);
}
