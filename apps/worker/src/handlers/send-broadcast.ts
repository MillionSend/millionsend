import { randomUUID } from "node:crypto";
import {
  broadcastSendSpacingMs,
  buildUnsubscribeHeaders,
  encryptEmailBody,
  escapeHtml,
  fetchDeliverabilityHealth,
  fetchEffectivePlan,
  findSuppressed,
  isSubscribedToTopic,
  type Keyring,
  makeUnsubscribeToken,
  PLAN_DAILY_LIMIT,
  parseSingleSender,
  regionPause,
  reserveDailyQuota,
  segmentContactsWhere,
  substituteUnsubscribeUrl,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";

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
  enqueueEmailSend: (emailId: string, startAfter?: Date) => Promise<void>;
  /** Re-enqueue a not-yet-due scheduled broadcast at its due time. */
  reschedule?: ((broadcastId: string, at: Date) => Promise<void>) | undefined;
  batchSize?: number | undefined;
}

export type BroadcastOutcome = "sent" | "skipped" | "deferred";

/** How long a fan-out waits before re-checking a held region. */
const REGION_HOLD_RETRY_MS = 15 * 60 * 1000;

// Resend's broadcast merge syntax: {{{NAME}}} or {{{NAME|fallback}}}. NAME is a
// builtin (FIRST_NAME/LAST_NAME/EMAIL) or a custom-property key; a name with no
// matching value falls back (or resolves to "") so no raw token reaches an inbox.
const MERGE_TOKEN = /\{\{\{([A-Za-z0-9_]+)(?:\|([^{}]*))?\}\}\}/g;
// A token opening an href/src value: the contact value becomes the link's
// scheme, so only web/mail URLs may land there (a javascript:/data: link
// from an imported property is a phishing primitive, not personalization).
const URL_ATTRIBUTE_OPEN = /(?:href|src)\s*=\s*["']?$/i;
const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

export interface MergeContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  properties: Record<string, string>;
}

/**
 * Substitutes contact merge tokens. Builtins (EMAIL/FIRST_NAME/LAST_NAME) win
 * over a same-named custom property; any other name resolves against
 * `properties` by exact key. A null/empty value falls back to the token's
 * `|fallback` text, or to "" without one — the raw token must never reach an
 * inbox. Contact values are user data landing in markup, so the html body gets
 * them escaped; fallbacks are the author's own content and stay literal.
 */
export function applyMergeFields(
  content: string,
  contact: MergeContact,
  opts: { html: boolean },
): string {
  return content.replace(
    MERGE_TOKEN,
    (_match, field: string, fallback: string | undefined, offset: number) => {
      const value =
        field === "EMAIL"
          ? contact.email
          : field === "FIRST_NAME"
            ? contact.firstName
            : field === "LAST_NAME"
              ? contact.lastName
              : (contact.properties[field] ?? null);
      if (!value) return fallback ?? "";
      if (!opts.html) return value;
      const opensUrl = URL_ATTRIBUTE_OPEN.test(content.slice(Math.max(0, offset - 12), offset));
      if (opensUrl && !LINK_SCHEME.test(value)) return fallback ?? "";
      return escapeHtml(value);
    },
  );
}

/**
 * Hidden-preheader injection (the standard inbox-preview pattern): the preview
 * text goes first in the body inside a display:none container, padded with
 * zero-width characters so clients that ignore the hiding styles still don't
 * pull visible body content into the snippet. Inserted right after `<body>`
 * when present (full documents), else prepended (fragments).
 */
export function injectPreheader(html: string, previewText: string): string {
  const preheader = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(previewText)}${"&nbsp;&zwnj;".repeat(40)}</div>`;
  const bodyTag = /<body[^>]*>/i.exec(html);
  const at = bodyTag ? bodyTag.index + bodyTag[0].length : 0;
  return html.slice(0, at) + preheader + html.slice(at);
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
    .select({
      id: schema.domains.id,
      status: schema.domains.status,
      region: schema.domains.region,
    })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, broadcast.teamId), eq(schema.domains.name, fromDomain)));
  if (domain?.status !== "verified") {
    throw new Error(`broadcast ${broadcast.id}: sender domain ${fromDomain} is not verified`);
  }
  // Platform breaker: a broadcast scheduled before its region was held waits
  // it out like a not-yet-due one; the reconcile sweep keeps it alive.
  if (await regionPause(db, domain.region)) {
    await deps.reschedule?.(broadcast.id, new Date(Date.now() + REGION_HOLD_RETRY_MS));
    return "deferred";
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

  const plan = await fetchEffectivePlan(db, broadcast.teamId);
  if (!plan) throw new Error(`broadcast ${broadcast.id}: team ${broadcast.teamId} not found`);
  const dailyLimit = deps.isCloud ? PLAN_DAILY_LIMIT[plan] : null;

  // Topic-scoped send: fetch the topic's default once (it gates every contact
  // with no explicit override) and hydrate per-batch override rows below. A
  // null topicId is a global send and skips all of this.
  let topicDefault: boolean | null = null;
  if (broadcast.topicId) {
    const [topic] = await db
      .select({ defaultSubscribed: schema.topics.defaultSubscribed })
      .from(schema.topics)
      .where(eq(schema.topics.id, broadcast.topicId));
    if (!topic) throw new Error(`broadcast ${broadcast.id}: topic ${broadcast.topicId} not found`);
    topicDefault = topic.defaultSubscribed;
  }

  // Graduated throttle: a team over the deliverability risk line (warning or
  // paused) drips its fan-out so reputation can recover, instead of bursting.
  // A broadcast that reaches fan-out already "paused" (scheduled while healthy,
  // degraded since) is throttled here, not hard-halted — the initiation guards
  // (tRPC + API) are what block NEW paused sends; the fan-out's only job is to
  // avoid the burst. Evaluated once so the whole campaign shares one drip base.
  const health = await fetchDeliverabilityHealth(db, broadcast.teamId);
  const spacingMs = broadcastSendSpacingMs(health.status);
  const startMs = Date.now();
  let emitted = 0;

  // Optional segment: AND the shared resolver (filter matches plus manual
  // members) into the contact scan. The segment must belong to this
  // broadcast's team — a mismatch is a tampered/foreign reference, so refuse
  // rather than mail the wrong people.
  let segmentPredicate: SQL | undefined;
  if (broadcast.segmentId) {
    const [segment] = await db
      .select({ id: schema.segments.id, filter: schema.segments.filter })
      .from(schema.segments)
      .where(
        and(
          eq(schema.segments.id, broadcast.segmentId),
          eq(schema.segments.teamId, broadcast.teamId),
        ),
      );
    if (!segment) {
      throw new Error(
        `broadcast ${broadcast.id}: segment ${broadcast.segmentId} not found for its team`,
      );
    }
    segmentPredicate = segmentContactsWhere(schema.contacts, segment);
  }

  const replyTo = broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null;
  // The preheader is per-broadcast, so it is injected once here; merge tokens
  // inside it still personalize per contact below.
  const baseHtml =
    broadcast.html !== null && broadcast.previewText
      ? injectPreheader(broadcast.html, broadcast.previewText)
      : broadcast.html;
  const batchSize = deps.batchSize ?? 100;
  let cursor = "";
  for (;;) {
    const contacts = await db
      .select({
        id: schema.contacts.id,
        email: schema.contacts.email,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        properties: schema.contacts.properties,
      })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, broadcast.teamId),
          eq(schema.contacts.unsubscribed, false),
          gt(sql`${schema.contacts.id}::text`, cursor),
          segmentPredicate,
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
    // Explicit topic overrides for this batch (absence = topicDefault).
    const topicOverrides = new Map<string, boolean>();
    if (broadcast.topicId) {
      const rows = await db
        .select({
          contactId: schema.contactTopicSubscriptions.contactId,
          subscribed: schema.contactTopicSubscriptions.subscribed,
        })
        .from(schema.contactTopicSubscriptions)
        .where(
          and(
            eq(schema.contactTopicSubscriptions.topicId, broadcast.topicId),
            inArray(
              schema.contactTopicSubscriptions.contactId,
              contacts.map((c) => c.id),
            ),
          ),
        );
      for (const r of rows) topicOverrides.set(r.contactId, r.subscribed);
    }
    for (const contact of contacts) {
      if (suppressed.has(contact.email)) continue;
      if (
        broadcast.topicId &&
        !isSubscribedToTopic(topicOverrides.get(contact.id), topicDefault ?? false)
      ) {
        continue;
      }
      const token = makeUnsubscribeToken({
        contactId: contact.id,
        topicId: broadcast.topicId,
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
          : applyMergeFields(substituteUnsubscribeUrl(s, unsubscribeUrl), contact, opts);
      const emailId = randomUUID();
      const encrypted = await encryptEmailBody(
        {
          html: personalize(baseHtml, { html: true }),
          text: personalize(broadcast.text, { html: false }),
        },
        deps.keyring,
        { teamId: broadcast.teamId, rowId: emailId },
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
            id: emailId,
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
        // Only rows this run actually enqueues advance the drip — re-run
        // conflicts (accepted === null) don't, so a resumed fan-out keeps
        // spacing tight instead of leaving gaps for already-queued contacts.
        const startAfter = spacingMs > 0 ? new Date(startMs + emitted * spacingMs) : undefined;
        emitted += 1;
        try {
          await deps.enqueueEmailSend(accepted.id, startAfter);
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
