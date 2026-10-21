import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { extractAddrSpec } from "./suppressions.js";

/**
 * Topic subscription rule: an explicit override row wins; its absence falls
 * back to the topic's defaultSubscribed. Global unsubscribe is a separate gate
 * the caller applies on top of this.
 */
export function isSubscribedToTopic(
  override: boolean | null | undefined,
  defaultSubscribed: boolean,
): boolean {
  return override ?? defaultSubscribed;
}

/**
 * Returns the subset of `recipients` that must not receive mail for this
 * topic. A recipient matching a contact by (team, lower(addr-spec)) uses
 * their explicit subscription row, else the topic's default; a recipient with
 * no contact follows the default alone. Throws when the topic does not belong
 * to the team — callers validate ownership before accepting.
 */
export async function findTopicOptOuts(
  db: Db,
  teamId: string,
  topicId: string,
  recipients: readonly string[],
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const [topic] = await db
    .select({ defaultSubscribed: schema.topics.defaultSubscribed })
    .from(schema.topics)
    .where(and(eq(schema.topics.id, topicId), eq(schema.topics.teamId, teamId)));
  if (!topic) throw new Error(`topic ${topicId} not found for team ${teamId}`);

  const c = schema.contacts;
  const addrByRecipient = new Map(recipients.map((r) => [r, extractAddrSpec(r).toLowerCase()]));
  const contacts = await db
    .select({ id: c.id, email: c.email, unsubscribed: c.unsubscribed })
    .from(c)
    .where(
      and(eq(c.teamId, teamId), inArray(sql`lower(${c.email})`, [...addrByRecipient.values()])),
    );
  const contactByAddr = new Map(contacts.map((row) => [row.email.toLowerCase(), row]));

  const overrides = new Map<string, boolean>();
  if (contacts.length > 0) {
    const s = schema.contactTopicSubscriptions;
    const rows = await db
      .select({ contactId: s.contactId, subscribed: s.subscribed })
      .from(s)
      .where(
        and(
          eq(s.topicId, topicId),
          inArray(
            s.contactId,
            contacts.map((row) => row.id),
          ),
        ),
      );
    for (const row of rows) overrides.set(row.contactId, row.subscribed);
  }

  // A globally unsubscribed contact is out of every topic, whatever their
  // per-topic rows say: the global flag is the wider choice.
  const optedOut = new Set<string>();
  for (const [recipient, addr] of addrByRecipient) {
    const contact = contactByAddr.get(addr);
    const override = contact ? overrides.get(contact.id) : undefined;
    if (contact?.unsubscribed || !isSubscribedToTopic(override, topic.defaultSubscribed)) {
      optedOut.add(recipient);
    }
  }
  return optedOut;
}

/** Why a topic delete was refused. */
export type TopicDeleteRefusal = "not_found" | "in_broadcast" | "emails_waiting";

/**
 * Deletes one of a team's topics, or says why it can't. A broadcast holds its
 * topic by foreign key. An email holds it only by a set-null key, so one still
 * waiting to go out (queued or parked, and not yet handed to SES) would leave
 * as a plain email: past the topic's opt-outs, which this delete cascades
 * away, and with its unsubscribe placeholders unfilled. The topic row is
 * locked first, so an email or broadcast created alongside the delete either
 * commits before the checks below see it or waits for the delete and then
 * fails its own key. Returns null once the topic is gone.
 */
export async function deleteTopic(
  db: Db,
  teamId: string,
  topicId: string,
): Promise<TopicDeleteRefusal | null> {
  return db.transaction(async (tx) => {
    const t = schema.topics;
    const [topic] = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, topicId), eq(t.teamId, teamId)))
      .for("update");
    if (!topic) return "not_found";
    const b = schema.broadcasts;
    const [broadcast] = await tx
      .select({ id: b.id })
      .from(b)
      .where(eq(b.topicId, topicId))
      .limit(1);
    if (broadcast) return "in_broadcast";
    const e = schema.emails;
    const [waiting] = await tx
      .select({ id: e.id })
      .from(e)
      .where(
        and(
          eq(e.teamId, teamId),
          eq(e.topicId, topicId),
          inArray(e.latestStatus, ["queued", "queued_quota"]),
          isNull(e.sesMessageId),
        ),
      )
      .limit(1);
    if (waiting) return "emails_waiting";
    await tx.delete(t).where(eq(t.id, topicId));
    return null;
  });
}
