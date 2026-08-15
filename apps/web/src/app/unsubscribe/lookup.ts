import { env } from "@millionsend/config";
import { deriveUnsubscribeKey, verifyUnsubscribeToken } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

export interface UnsubscribeContact {
  id: string;
  email: string;
  unsubscribed: boolean;
}

/**
 * Token → contact, or null for anything invalid (bad signature, unknown or
 * deleted contact, missing key). Callers must render every null the same
 * way — the public page never confirms whether a contact exists.
 */
export async function contactForToken(db: Db, token: string): Promise<UnsubscribeContact | null> {
  if (!env.MASTER_ENCRYPTION_KEY) return null;
  const key = deriveUnsubscribeKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"));
  const contactId = verifyUnsubscribeToken(token, key);
  // Non-uuid payloads can't be minted by us, but a raw string must never
  // reach the uuid column — Postgres would 500 instead of rendering the
  // neutral page.
  if (!contactId || !z.uuid().safeParse(contactId).success) return null;
  const t = schema.contacts;
  const [contact] = await db
    .select({ id: t.id, email: t.email, unsubscribed: t.unsubscribed })
    .from(t)
    .where(eq(t.id, contactId))
    .limit(1);
  return contact ?? null;
}
