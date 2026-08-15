import {
  buildUnsubscribeHeaders,
  encryptEmailBody,
  findSuppressed,
  type Keyring,
  makeUnsubscribeToken,
  PLAN_DAILY_LIMIT,
  parseSingleSender,
  reserveDailyQuota,
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
  /** Cloud enforces plan quotas; self-host sends without caps. */
  isCloud: boolean;
  enqueueEmailSend: (emailId: string) => Promise<void>;
  /** Re-enqueue a not-yet-due scheduled broadcast at its due time. */
  reschedule?: ((broadcastId: string, at: Date) => Promise<void>) | undefined;
  batchSize?: number | undefined;
}

export type BroadcastOutcome = "sent" | "skipped" | "deferred" | "canceled";

/** Literal token replaced per recipient with their hosted unsubscribe URL. */
const UNSUBSCRIBE_URL_TOKEN = "{{{UNSUBSCRIBE_URL}}}";

// Resend's broadcast merge syntax: {{{FIRST_NAME}}} or {{{FIRST_NAME|there}}}.
// Only the three contact fields match; any other {{{…}}} stays literal.
const MERGE_TOKEN = /\{\{\{(FIRST_NAME|LAST_NAME|EMAIL)(?:\|([^{}]*))?\}\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface MergeContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Substitutes contact merge tokens. A null/empty field falls back to the
 * token's `|fallback` text, or to "" without one — the raw token must never
 * reach an inbox. Contact values are user data landing in markup, so the
 * html body gets them escaped; fallbacks are the author's own content and
 * stay literal.
 */
export function applyMergeFields(
  content: string,
  contact: MergeContact,
  opts: { html: boolean },
): string {
  return content.replace(MERGE_TOKEN, (_match, field: string, fallback: string | undefined) => {
    const value =
      field === "EMAIL"
        ? contact.email
        : field === "FIRST_NAME"
          ? contact.firstName
          : contact.lastName;
    if (!value) return fallback ?? "";
    return opts.html ? escapeHtml(value) : value;
  });
}

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
  // matter how the job arrived. (The sending-claim CAS below re-checks this
  // atomically — that, not this read, is what makes a racing cancel safe.)
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
  // SECURITY: broadcast.from is emitted verbatim into every fanned-out email,
  // so the domain checked here must come from the same strict single-mailbox
  // parser the accept paths use — a lenient extractor could verify one address
  // of an ambiguous legacy value while another gets emitted.
  const sender = parseSingleSender(broadcast.from);
  if (!sender) {
    throw new Error(
      `broadcast ${broadcast.id}: from is not a single unambiguous mailbox; refusing to send`,
    );
  }
  const fromDomain = sender.domain;
  const [domain] = await db
    .select({ id: schema.domains.id, status: schema.domains.status })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, broadcast.teamId), eq(schema.domains.name, fromDomain)));
  if (domain?.status !== "verified") {
    throw new Error(`broadcast ${broadcast.id}: sender domain ${fromDomain} is not verified`);
  }

  const [claimed] = await db
    .update(schema.broadcasts)
    .set({ status: "sending", updatedAt: new Date() })
    .where(
      and(
        eq(schema.broadcasts.id, broadcast.id),
        inArray(schema.broadcasts.status, ["scheduled", "sending"]),
      ),
    )
    .returning({ id: schema.broadcasts.id });
  // This CAS is the authoritative gate, not the SELECT above: a cancel
  // landing between the two flips the status, the CAS matches zero rows,
  // and fanning out anyway would mail a canceled audience.
  if (!claimed) return "skipped";

  const [team] = await db
    .select({ plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, broadcast.teamId));
  if (!team) throw new Error(`broadcast ${broadcast.id}: team ${broadcast.teamId} not found`);
  const dailyLimit = deps.isCloud ? PLAN_DAILY_LIMIT[team.plan] : null;

  const replyTo = broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null;
  const batchSize = deps.batchSize ?? 100;
  let cursor = "";
  for (;;) {
    const contacts = await db
      .select({
        id: schema.contacts.id,
        email: schema.contacts.email,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
      })
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
      // Unsubscribe first: replaced segments are not rescanned, so a hostile
      // contact field containing the token can never inject the URL swap.
      const personalize = (s: string | null, opts: { html: boolean }) =>
        s === null
          ? null
          : applyMergeFields(s.replaceAll(UNSUBSCRIBE_URL_TOKEN, unsubscribeUrl), contact, opts);
      const encrypted = await encryptEmailBody(
        {
          html: personalize(broadcast.html, { html: true }),
          text: personalize(broadcast.text, { html: false }),
        },
        deps.keyring,
      );
      // Quota reservation and email insert commit atomically (the quota
      // contract), same as the API accept path — a broadcast must not
      // bypass the plan's daily cap.
      const accepted = await db.transaction(async (tx) => {
        // Insert before reserving: a conflict means a previous run already
        // fanned this contact out (and reserved quota for it), so a re-run
        // must not burn quota again.
        const [row] = await tx
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
        if (!row) return null;
        const quota = await reserveDailyQuota(tx as unknown as Db, {
          teamId: broadcast.teamId,
          count: 1,
          limit: dailyLimit,
        });
        if (quota.reserved) return { id: row.id, parked: false };
        // Over the plan cap: park as queued_quota — accepted but not
        // enqueued; the daily quota drain moves it to queued after the UTC
        // rollover.
        await tx
          .update(schema.emails)
          .set({ latestStatus: "queued_quota" })
          .where(eq(schema.emails.id, row.id));
        return { id: row.id, parked: true };
      });
      // null → this contact was fanned out by a previous run; its job is
      // already queued (or the sends.reconcile sweep recovers it).
      if (accepted && !accepted.parked) {
        try {
          await deps.enqueueEmailSend(accepted.id);
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
