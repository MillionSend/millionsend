import {
  buildUnsubscribeHeaders,
  encryptEmailBody,
  extractAddrSpec,
  findSuppressed,
  type Keyring,
  makeUnsubscribeToken,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

/**
 * Fans a broadcast out into individual email rows and email.send jobs — the
 * same accepted-email pipeline API sends flow through. Idempotent by the
 * partial unique index on (broadcastId, contactId): a re-run (job retry,
 * reconcile overlap) inserts nothing for contacts already fanned out, so a
 * contact can never be double-sent.
 */

export interface BroadcastDeps {
  keyring: Keyring;
  /** HMAC key for unsubscribe tokens (deriveUnsubscribeKey(masterKey)). */
  unsubscribeSecretKey: Buffer;
  /** Public base URL hosting /unsubscribe/<token>; absent → fan-out refuses. */
  appBaseUrl: string | undefined;
  enqueueEmailSend: (emailId: string) => Promise<void>;
  /** Re-enqueue a not-yet-due scheduled broadcast at its due time. */
  reschedule?: ((broadcastId: string, at: Date) => Promise<void>) | undefined;
  batchSize?: number | undefined;
}

export type BroadcastOutcome = "sent" | "skipped" | "deferred" | "canceled";

/** Literal token replaced per recipient with their hosted unsubscribe URL. */
const UNSUBSCRIBE_URL_TOKEN = "{{{UNSUBSCRIBE_URL}}}";

export async function sendBroadcast(
  db: Db,
  deps: BroadcastDeps,
  payload: { broadcastId: string },
): Promise<BroadcastOutcome> {
  const [broadcast] = await db
    .select()
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, payload.broadcastId));
  // Only scheduled/sending proceed: draft, canceled, and sent are no-ops no
  // matter how the job arrived — this re-check is what makes a cancel racing
  // the fan-out safe.
  if (!broadcast || (broadcast.status !== "scheduled" && broadcast.status !== "sending")) {
    return "skipped";
  }
  if (
    broadcast.status === "scheduled" &&
    broadcast.scheduledAt &&
    broadcast.scheduledAt.getTime() > Date.now()
  ) {
    await deps.reschedule?.(broadcast.id, broadcast.scheduledAt);
    return "deferred";
  }
  if (!deps.appBaseUrl) {
    // Loud failure: the job retries and logs. Never silently send a
    // broadcast without its unsubscribe URL and headers.
    throw new Error(
      `broadcast ${broadcast.id}: APP_BASE_URL is required for unsubscribe links; refusing to send`,
    );
  }
  if (!broadcast.audienceId) {
    // Audience deleted after scheduling: there is no one to send to.
    await db
      .update(schema.broadcasts)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(eq(schema.broadcasts.id, broadcast.id));
    return "canceled";
  }

  // Resolve the sender's verified domain (region + configuration set for the
  // per-email send). Verified at schedule time; a loud failure here means it
  // was un-verified since.
  const addr = extractAddrSpec(broadcast.from);
  const fromDomain = addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();
  const [domain] = await db
    .select({ id: schema.domains.id, status: schema.domains.status })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, broadcast.teamId), eq(schema.domains.name, fromDomain)));
  if (domain?.status !== "verified") {
    throw new Error(`broadcast ${broadcast.id}: sender domain ${fromDomain} is not verified`);
  }

  await db
    .update(schema.broadcasts)
    .set({ status: "sending", updatedAt: new Date() })
    .where(
      and(
        eq(schema.broadcasts.id, broadcast.id),
        inArray(schema.broadcasts.status, ["scheduled", "sending"]),
      ),
    );

  const replyTo = broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null;
  const batchSize = deps.batchSize ?? 100;
  let cursor = "";
  for (;;) {
    const contacts = await db
      .select({ id: schema.contacts.id, email: schema.contacts.email })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.audienceId, broadcast.audienceId),
          eq(schema.contacts.unsubscribed, false),
          gt(sql`${schema.contacts.id}::text`, cursor),
        ),
      )
      .orderBy(asc(sql`${schema.contacts.id}::text`))
      .limit(batchSize);
    if (contacts.length === 0) break;
    cursor = contacts[contacts.length - 1]?.id ?? "";

    // Suppression mirrors the API accept path: a bounced or complained
    // address must never receive bulk mail again, or SES reputation pays.
    const suppressed = await findSuppressed(
      db,
      broadcast.teamId,
      contacts.map((c) => c.email),
    );
    for (const contact of contacts) {
      if (suppressed.has(contact.email)) continue;
      const token = makeUnsubscribeToken({
        contactId: contact.id,
        secretKey: deps.unsubscribeSecretKey,
      });
      const headers = buildUnsubscribeHeaders(deps.appBaseUrl, token);
      // "<url>" → url; reusing the header builder keeps link and header
      // pointing at the exact same page.
      const unsubscribeUrl = headers["List-Unsubscribe"].slice(1, -1);
      const personalize = (s: string | null) =>
        s === null ? null : s.replaceAll(UNSUBSCRIBE_URL_TOKEN, unsubscribeUrl);
      const encrypted = await encryptEmailBody(
        { html: personalize(broadcast.html), text: personalize(broadcast.text) },
        deps.keyring,
      );
      const [row] = await db
        .insert(schema.emails)
        .values({
          teamId: broadcast.teamId,
          domainId: domain.id,
          broadcastId: broadcast.id,
          contactId: contact.id,
          from: broadcast.from,
          to: [contact.email],
          replyTo,
          subject: broadcast.subject,
          latestStatus: "queued",
          bodyCiphertext: encrypted.ciphertext,
          bodyIv: encrypted.iv,
          bodyWrappedDek: encrypted.wrappedDek,
          bodyKeyVersion: encrypted.keyVersion,
        })
        .onConflictDoNothing({
          target: [schema.emails.broadcastId, schema.emails.contactId],
          where: sql`${schema.emails.broadcastId} is not null`,
        })
        .returning({ id: schema.emails.id });
      // Conflict → this contact was fanned out by a previous run; its job is
      // already queued (or the sends.reconcile sweep recovers it).
      if (row) {
        try {
          await deps.enqueueEmailSend(row.id);
        } catch (err) {
          console.error("email.send enqueue failed; reconcile sweep will recover", err);
        }
      }
    }
  }

  await db
    .update(schema.broadcasts)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.broadcasts.id, broadcast.id), eq(schema.broadcasts.status, "sending")));
  return "sent";
}
