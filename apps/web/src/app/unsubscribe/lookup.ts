import { env } from "@millionsend/config";
import {
  deriveUnsubscribeKey,
  isSubscribedToTopic,
  verifyUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { appBaseUrl } from "@/lib/api-base-url";
import { uploadsEnabled } from "@/server/storage";

/** Per-team customization the hosted confirm page applies; all fields optional. */
export interface UnsubscribeCustomization {
  brandName: string | null;
  message: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  /** Set only when the team opted in AND a servable logo exists. */
  logoUrl: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  accentColor: string | null;
}

export interface UnsubscribeTarget {
  contactId: string;
  teamId: string;
  email: string;
  /** null = global unsubscribe; set = topic-scoped. */
  topic: { id: string; name: string } | null;
  /** Already unsubscribed from this scope — the confirm page reads as done. */
  alreadyDone: boolean;
  /** The contact's team's customization for the confirm page. */
  customization: UnsubscribeCustomization;
}

export interface PreferenceTopic {
  id: string;
  name: string;
  /** Effective state: the explicit override, else the topic's default. */
  subscribed: boolean;
}

/**
 * Topics the confirm page's preferences list shows and the POST handler may
 * write: the team's public topics, plus the token's own topic when private —
 * a private topic's own unsubscribe link must still render it. This set is
 * the write allowlist too: ids posted outside it are ignored.
 */
export async function preferenceTopics(
  db: Db,
  target: UnsubscribeTarget,
): Promise<PreferenceTopic[]> {
  const t = schema.topics;
  const s = schema.contactTopicSubscriptions;
  const visible = target.topic
    ? or(eq(t.visibility, "public"), eq(t.id, target.topic.id))
    : eq(t.visibility, "public");
  const rows = await db
    .select({ id: t.id, name: t.name, defaultSubscribed: t.defaultSubscribed, sub: s.subscribed })
    .from(t)
    .leftJoin(s, and(eq(s.topicId, t.id), eq(s.contactId, target.contactId)))
    .where(and(eq(t.teamId, target.teamId), visible))
    .orderBy(asc(t.createdAt), asc(t.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    subscribed: isSubscribedToTopic(row.sub, row.defaultSubscribed),
  }));
}

/**
 * Where the browser lands after a (non-one-click) unsubscribe POST: the team's
 * configured redirect when set, else the in-place done state. Absolute string
 * (on APP_BASE_URL, never the request's Host) so it can go straight into a
 * Location header.
 */
export function postUnsubscribeLocation(token: string, redirectUrl: string | null): string {
  if (redirectUrl) return redirectUrl;
  return new URL(
    `/unsubscribe/confirm/${encodeURIComponent(token)}?done=1`,
    appBaseUrl(),
  ).toString();
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
  const tm = schema.teams;
  const [contact] = await db
    .select({
      id: c.id,
      email: c.email,
      teamId: c.teamId,
      unsubscribed: c.unsubscribed,
      teamName: tm.name,
      brandName: tm.unsubscribeBrandName,
      message: tm.unsubscribeMessage,
      successMessage: tm.unsubscribeSuccessMessage,
      redirectUrl: tm.unsubscribeRedirectUrl,
      backgroundColor: tm.unsubscribeBackgroundColor,
      textColor: tm.unsubscribeTextColor,
      accentColor: tm.unsubscribeAccentColor,
      hideBranding: tm.unsubscribeHideBranding,
      logoUrl: tm.logoUrl,
    })
    .from(c)
    .innerJoin(tm, eq(tm.id, c.teamId))
    .where(eq(c.id, contactId))
    .limit(1);
  if (!contact) return null;

  const customization: UnsubscribeCustomization = {
    // No explicit brand name → the team's name, so recipients always see who
    // is emailing them rather than the MillionSend wordmark.
    brandName: contact.brandName ?? contact.teamName,
    message: contact.message,
    successMessage: contact.successMessage,
    redirectUrl: contact.redirectUrl,
    // Storage off ⇒ stored URLs may be dead; fall back to name/wordmark.
    logoUrl: contact.hideBranding && uploadsEnabled() ? contact.logoUrl : null,
    backgroundColor: contact.backgroundColor,
    textColor: contact.textColor,
    accentColor: contact.accentColor,
  };

  if (topicId === null) {
    return {
      contactId: contact.id,
      teamId: contact.teamId,
      email: contact.email,
      topic: null,
      alreadyDone: contact.unsubscribed,
      customization,
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
    teamId: contact.teamId,
    email: contact.email,
    topic: { id: topic.id, name: topic.name },
    alreadyDone: !effective,
    customization,
  };
}
