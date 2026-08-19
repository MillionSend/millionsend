import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, sql } from "drizzle-orm";
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
    .select({ id: c.id, email: c.email })
    .from(c)
    .where(
      and(eq(c.teamId, teamId), inArray(sql`lower(${c.email})`, [...addrByRecipient.values()])),
    );
  const contactIdByAddr = new Map(contacts.map((row) => [row.email.toLowerCase(), row.id]));

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

  const optedOut = new Set<string>();
  for (const [recipient, addr] of addrByRecipient) {
    const contactId = contactIdByAddr.get(addr);
    const override = contactId ? overrides.get(contactId) : undefined;
    if (!isSubscribedToTopic(override, topic.defaultSubscribed)) optedOut.add(recipient);
  }
  return optedOut;
}
