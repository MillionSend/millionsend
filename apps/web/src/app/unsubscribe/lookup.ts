import { env } from "@millionsend/config";
import {
  deriveUnsubscribeKey,
  isSubscribedToTopic,
  verifyUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export interface UnsubscribeTarget {
  contactId: string;
  email: string;
  /** null = global unsubscribe; set = topic-scoped. */
  topic: { id: string; name: string } | null;
  /** Already unsubscribed from this scope — the confirm page reads as done. */
  alreadyDone: boolean;
}

/**
 * Token → the exact thing it unsubscribes from, or null for anything invalid
 * (bad signature, non-uuid ids, unknown/deleted contact, or a topic-scoped
 * token whose topic was deleted). Callers must render every null the same
 * way — the public page never confirms whether a contact or topic exists.
 */
export async function targetForToken(db: Db, token: string): Promise<UnsubscribeTarget | null> {
  if (!env.MASTER_ENCRYPTION_KEY) return null;
  const key = deriveUnsubscribeKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"));
  const parsed = verifyUnsubscribeToken(token, key);
  if (!parsed) return null;
  const { contactId, topicId } = parsed;
  // Non-uuid payloads can't be minted by us, but a raw string must never
  // reach a uuid column — Postgres would 500 instead of rendering neutral.
  if (!z.uuid().safeParse(contactId).success) return null;
  if (topicId !== null && !z.uuid().safeParse(topicId).success) return null;

  const c = schema.contacts;
  const [contact] = await db
    .select({ id: c.id, email: c.email, teamId: c.teamId, unsubscribed: c.unsubscribed })
    .from(c)
    .where(eq(c.id, contactId))
    .limit(1);
  if (!contact) return null;

  if (topicId === null) {
    return {
      contactId: contact.id,
      email: contact.email,
      topic: null,
      alreadyDone: contact.unsubscribed,
    };
  }

  // Topic-scoped: the topic must still exist and belong to the contact's team.
  const t = schema.topics;
  const [topic] = await db
    .select({ id: t.id, name: t.name, defaultSubscribed: t.defaultSubscribed })
    .from(t)
    .where(and(eq(t.id, topicId), eq(t.teamId, contact.teamId)))
    .limit(1);
  if (!topic) return null;

  // Effective state: the explicit override, else the topic's default. Absence
  // of a row is not "unsubscribed" — it is the default.
  const s = schema.contactTopicSubscriptions;
  const [sub] = await db
    .select({ subscribed: s.subscribed })
    .from(s)
    .where(and(eq(s.contactId, contact.id), eq(s.topicId, topic.id)))
    .limit(1);
  const effective = isSubscribedToTopic(sub?.subscribed, topic.defaultSubscribed);
  return {
    contactId: contact.id,
    email: contact.email,
    topic: { id: topic.id, name: topic.name },
    alreadyDone: !effective,
  };
}
