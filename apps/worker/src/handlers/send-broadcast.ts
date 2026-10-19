import { randomUUID } from "node:crypto";
import {
  type AccountMailKind,
  accountMailPhrase,
  applyMergeFields,
  broadcastAudienceWhere,
  broadcastScreen,
  broadcastSendSpacingMs,
  buildAccountMail,
  buildUnsubscribeHeaders,
  cancelBroadcastRows,
  claimNotification,
  contactActivity,
  contactPropertyDateSql,
  drawBroadcastCopy,
  encryptEmailBody,
  fetchDeliverabilityHealth,
  fetchTeamQuota,
  fetchTeamStanding,
  findSuppressed,
  formatMailDate,
  formatMailDateTime,
  getWarmup,
  injectPreheader,
  isInactiveContact,
  isSubscribedToTopic,
  type Keyring,
  linkTeam,
  type MailLocale,
  type MonitorDeps,
  makeUnsubscribeToken,
  NOVEL_DESTINATIONS_MAX,
  nextUtcDayStart,
  PACING_HORIZON_MAX_RETENTION_DAYS,
  pacingHorizonDays,
  parseSingleSender,
  planBroadcastSamples,
  planCaps,
  planDomainWarmup,
  planRegionSend,
  quotaUsage,
  type RegionCapacity,
  recentTransactionalByAddress,
  recordMonitorSample,
  regionPause,
  releaseQuota,
  reserveQuota,
  reserveWarmup,
  roundUpToSlot,
  type ScreenParkReason,
  screeningTeam,
  segmentContactsWhere,
  substituteUnsubscribeUrl,
  teamDestinationStanding,
  utcDay,
  warmupCap,
  warmupSendOrder,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { EmailSendRequest, EnqueueEmailSends } from "@millionsend/queue";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { mailOwners, type SystemMailer } from "../system-mail.js";

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
  unsubscribeBaseUrl: string | undefined;
  /** Cloud enforces plan quotas; self-host sends without caps. */
  isCloud: boolean;
  /** One call per contact page; the wiring sets the bulk priority. */
  enqueueEmailSends: EnqueueEmailSends;
  /** Re-enqueue a not-yet-due scheduled broadcast at its due time. */
  reschedule?: ((broadcastId: string, at: Date) => Promise<void>) | undefined;
  /**
   * The job's abort signal: aborted on worker shutdown and when the job
   * expires under a walk that is still running. Checked once per page, so
   * either ends the walk within a page by throwing, which fails the job into
   * pg-boss's retry so the next boot resumes it (the broadcasts.reconcile
   * sweep is the backstop); nothing is re-enqueued here.
   */
  signal?: AbortSignal | undefined;
  batchSize?: number | undefined;
  /** Owners hear when the broadcast went out or is held; absent = silent (tests). */
  mailer?: SystemMailer | undefined;
  /**
   * The broadcast share of the sender domain's SES region: the walk admits
   * up to the room it finds and parks the rest for the drain, instead of
   * every fanned-out row parking one by one in the send handler. Absent
   * (tests, an unpaced deployment) everything is admitted.
   */
  sesQuota?: BroadcastQuotaControls | undefined;
  /** Days a paced send may take; the owner's estimate stops there. Read per walk end, like the retention it derives from. */
  horizonDays?: (() => Promise<number>) | undefined;
  /** Dashboard origin for the links in those mails. */
  appBaseUrl?: string | undefined;
  /** The content monitor: the skeleton sample at fan-out start and the copies drawn per recipient. */
  monitor?: MonitorDeps | undefined;
  /** The platform's own link domains (unsubscribe, tracking): never a customer's destination. */
  platformDomains?: ReadonlySet<string> | undefined;
}

/**
 * One report to the owners about a broadcast; never throws, the fan-out's
 * outcome stands whatever the mail does.
 */
async function report(
  db: Db,
  deps: Pick<BroadcastDeps, "mailer" | "appBaseUrl">,
  broadcast: { id: string; teamId: string },
  kind: AccountMailKind,
  path: string,
  values: (locale: MailLocale, team: string) => Record<string, string>,
): Promise<void> {
  if (!deps.mailer) return;
  try {
    const [team] = await db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, broadcast.teamId));
    if (!team) return;
    await mailOwners(db, deps.mailer, broadcast.teamId, kind, (locale) =>
      buildAccountMail({
        kind,
        locale,
        url: `${deps.appBaseUrl ?? ""}${path}`,
        values: values(locale, team.name),
      }),
    );
  } catch (err) {
    console.error(`broadcast ${broadcast.id}: ${kind} mail skipped`, err);
  }
}

/** The room ledger and the region facts the fan-out and its walk-end report read. */
export interface BroadcastQuotaControls {
  take(region: string | undefined, walkId: string, n: number): number;
  progress(walkId: string, emitted: number): void;
  done(walkId: string): void;
  reserve(): number;
  capacity(region?: string): RegionCapacity | null;
  rate(region?: string): number;
}

export type BroadcastOutcome = "sent" | "skipped" | "deferred";

/** How long a fan-out waits before re-checking a held region. */
const REGION_HOLD_RETRY_MS = 15 * 60 * 1000;

// The merge and preheader helpers live in core so the dashboard's test send
// renders exactly what the fan-out renders; re-exported for the callers that
// reach them through this handler.
export { applyMergeFields, injectPreheader, type MergeContact } from "@millionsend/core";

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
  if (!deps.unsubscribeBaseUrl) {
    // Loud failure: the job retries and logs. Never silently send a
    // broadcast without its unsubscribe URL and headers.
    throw new Error(
      `broadcast ${broadcast.id}: APP_BASE_URL (or UNSUBSCRIBE_BASE_URL) is required for unsubscribe links; refusing to send`,
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
    // Said once per broadcast, however many 15-minute waits the hold lasts.
    if (
      deps.mailer &&
      (await claimNotification(db, {
        teamId: broadcast.teamId,
        kind: `broadcast.held:${broadcast.id}`,
        periodKey: "region",
      }))
    ) {
      await report(
        db,
        deps,
        broadcast,
        "broadcast.held",
        `/broadcasts/${broadcast.id}`,
        (_, team) => ({ name: broadcast.name ?? broadcast.subject, team }),
      );
    }
    await deps.reschedule?.(broadcast.id, new Date(Date.now() + REGION_HOLD_RETRY_MS));
    return "deferred";
  }
  // A team in its first window that shares people, domains or this
  // broadcast with a team suspended for phishing is held before it fans
  // out: the standing read below then parks the fan-out.
  if (deps.monitor) {
    const s = await deps.monitor.settings().catch(() => null);
    const team = s ? await screeningTeam(db, s, broadcast.teamId, new Date()) : null;
    if (team?.firstWindow) {
      await linkTeam(db, {
        teamId: broadcast.teamId,
        trigger: "send",
        message: {
          from: broadcast.from,
          subject: broadcast.subject,
          html: broadcast.html,
          text: broadcast.text,
        },
        tier: team.tier,
      });
    }
  }
  // An operator's pause or suspension parks the fan-out the way a region
  // hold does; the owners heard about it when the operator acted.
  const standing = await fetchTeamStanding(db, broadcast.teamId);
  if (standing?.suspended || standing?.broadcastsPausedByOperatorAt) {
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

  const initialQuota = await fetchTeamQuota(db, broadcast.teamId, deps.isCloud);
  if (!initialQuota)
    throw new Error(`broadcast ${broadcast.id}: team ${broadcast.teamId} not found`);
  let quota = initialQuota;

  // Topic-scoped send: fetch the topic's default once (it gates every contact
  // with no explicit override) and hydrate per-batch override rows below. A
  // null topicId is a global send and skips all of this.
  const [topic = null] = broadcast.topicId
    ? await db
        .select({ id: schema.topics.id, defaultSubscribed: schema.topics.defaultSubscribed })
        .from(schema.topics)
        .where(eq(schema.topics.id, broadcast.topicId))
    : [];
  if (broadcast.topicId && !topic) {
    throw new Error(`broadcast ${broadcast.id}: topic ${broadcast.topicId} not found`);
  }
  const topicDefault = topic?.defaultSubscribed ?? null;

  // Graduated throttle: a team over the deliverability risk line (warning or
  // paused) drips its fan-out so reputation can recover, instead of bursting.
  // A broadcast that reaches fan-out already "paused" (scheduled while healthy,
  // degraded since) is throttled here, not hard-halted — the initiation guards
  // (tRPC + API) are what block NEW paused sends; the fan-out's only job is to
  // avoid the burst. Health is read at every page edge, so a team that crosses
  // the line mid-walk drips the rest from that page on. The drip never loosens
  // within a walk, since the slots it handed out are still ahead, and a
  // tighter one starts after the last of them instead of on top. While the
  // team stays paused, the send handler parks each row as it comes due.
  let spacingMs = 0;
  let nextSendMs = 0;
  let emitted = 0;

  // Optional segment: AND the shared resolver (filter matches plus manual
  // members) into the contact scan. The segment must belong to this
  // broadcast's team — a mismatch is a tampered/foreign reference, so refuse
  // rather than mail the wrong people.
  const [segment = null] = broadcast.segmentId
    ? await db
        .select({ id: schema.segments.id, filter: schema.segments.filter })
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.id, broadcast.segmentId),
            eq(schema.segments.teamId, broadcast.teamId),
          ),
        )
    : [];
  if (broadcast.segmentId && !segment) {
    throw new Error(
      `broadcast ${broadcast.id}: segment ${broadcast.segmentId} not found for its team`,
    );
  }
  const segmentPredicate = segment ? segmentContactsWhere(schema.contacts, segment) : undefined;

  // The audience over the same predicate the walk pages over, with the
  // topic rule the walk applies so it holds for an opt-in topic too. An
  // upper bound: the suppressed and topic-unsubscribed contacts the walk
  // skips make the real count run a little under. It sizes the admission
  // into the region's broadcast share and the monitor's draw.
  const [audience] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.contacts)
    .where(broadcastAudienceWhere(broadcast.teamId, segment, topic));
  const audienceCount = audience?.n ?? 0;
  await db
    .update(schema.broadcasts)
    .set({ audienceCount })
    .where(eq(schema.broadcasts.id, broadcast.id));

  // The monitor judges the broadcast's own HTML once and a few rendered
  // copies: the expected count is `copies`, so the draw needs the audience
  // size. For a new team, or HTML that sends readers somewhere the team has
  // not cleared, with the hold on, the walk writes no row until the HTML has
  // its verdict; a new team's first copy waits for its own too: a contact
  // field can carry a whole link. HTML with more new destinations than a
  // verdict can vouch for parks every row for an operator unjudged. A
  // failure here fails the walk, which is retried: never fanned out
  // unscreened.
  let monitorCopies = 0;
  let monitorAudience = 0;
  let screenFirstCopy = false;
  let screenParked: ScreenParkReason | null = null;
  if (deps.monitor) {
    const standing = await teamDestinationStanding(db, {
      teamId: broadcast.teamId,
      html: broadcast.html,
      text: broadcast.text,
      replyTo: broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null,
      ignore: deps.platformDomains,
      now: new Date(),
    });
    if (standing.novel.length > NOVEL_DESTINATIONS_MAX) {
      screenParked = "destination";
    } else {
      const plan = await planBroadcastSamples(db, deps.monitor, {
        teamId: broadcast.teamId,
        broadcastId: broadcast.id,
        novel: standing.novel.length > 0,
        probation: standing.probation.length > 0,
      });
      if (plan.copies > 0) {
        monitorAudience = audienceCount;
        monitorCopies = plan.copies;
      }
      if (plan.screen && plan.skeletonSampleId) {
        const gate = await broadcastScreen(db, deps.monitor, {
          skeletonSampleId: plan.skeletonSampleId,
          domainId: domain.id,
          now: new Date(),
        });
        // The judge queues the fan-out again once the HTML has its verdict.
        if (gate.action === "wait") return "deferred";
        if (gate.action === "park") screenParked = gate.reason;
        screenFirstCopy =
          screenParked === null &&
          plan.tier === "new" &&
          !(await firstCopyScreened(db, broadcast.id));
      }
    }
  }
  // A domain warming up its reputation, or paused in it, admits nothing now:
  // every row parks in line by its contact's activity, and the drain lets
  // them out by the warm-up's day.
  const walkStart = new Date();
  const ramp = await getWarmup(db, broadcast.teamId, domain.id);
  const warming = ramp?.status === "warming" || ramp?.status === "paused" ? ramp : null;
  const transactional = warming?.orderByTransactional
    ? await recentTransactionalByAddress(db, broadcast.teamId, walkStart)
    : null;
  // The sender's choice in the send dialog, else the warm-up's own setting.
  const skipInactive = broadcast.warmupSkipInactive ?? warming?.skipInactive ?? false;
  // Inactive contacts left out on the page just walked: persisted with the
  // cursor that moves past that page, so a resumed walk never counts twice.
  let skipped = 0;
  const skippedSet = () =>
    skipped > 0 ? { warmupSkipped: sql`${schema.broadcasts.warmupSkipped} + ${skipped}` } : {};
  // Admission: the first `admitted` rows this walk writes get a job now; the
  // rest park for the drain. A resumed walk takes again against the count,
  // which already holds the rows it wrote before.
  const admitted = warming
    ? 0
    : (deps.sesQuota?.take(domain.region, broadcast.id, audienceCount) ?? Number.POSITIVE_INFINITY);
  const replyTo = broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null;
  // The preheader is per-broadcast, so it is injected once here; merge tokens
  // inside it still personalize per contact below.
  const baseHtml =
    broadcast.html !== null && broadcast.previewText
      ? injectPreheader(broadcast.html, broadcast.previewText)
      : broadcast.html;
  const batchSize = deps.batchSize ?? 100;
  // Keyset pages over (team_id, id): comparing the uuid column itself keeps
  // every page an index range; casting it to text made each page rescan the
  // whole team. The cursor advances only once a page's rows and jobs are
  // committed, and the heartbeat persists it, so a walk cut off mid-page
  // resumes from the last committed page and the unique index covers the
  // partial one.
  let cursor: string | null = broadcast.fanOutCursor;
  let walked: { recipientCount: number | null } | undefined;
  // Every way out of the walk closes its grant, or the room it did not use
  // would stay reserved until the process restarts.
  try {
    for (;;) {
      // Checked after the previous page's enqueue, so no enqueued page is lost.
      if (deps.signal?.aborted) throw new Error(`broadcast ${broadcast.id}: fan-out aborted`);
      // A billing period can renew under a long walk (the daily counter follows
      // the clock by itself); each page reserves against the period current now.
      quota = (await fetchTeamQuota(db, broadcast.teamId, deps.isCloud)) ?? quota;
      // The sending domain's warm-up and the team's shared one, read per page
      // like the quota: once either day is spent, the rest of the page parks
      // at insert behind it.
      const warmup = await warmupCap(db, {
        teamId: broadcast.teamId,
        domainId: domain.id,
        at: new Date(),
      });
      let warmupFull = false;
      const contacts = await db
        .select({
          id: schema.contacts.id,
          email: schema.contacts.email,
          firstName: schema.contacts.firstName,
          lastName: schema.contacts.lastName,
          properties: schema.contacts.properties,
          lastEngagedAt: schema.contacts.lastEngagedAt,
          propertyAt: warming?.orderProperty
            ? contactPropertyDateSql(warming.orderProperty)
            : sql<Date | null>`null`,
        })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.teamId, broadcast.teamId),
            eq(schema.contacts.unsubscribed, false),
            cursor ? gt(schema.contacts.id, cursor) : undefined,
            segmentPredicate,
          ),
        )
        .orderBy(asc(schema.contacts.id))
        .limit(batchSize);
      if (contacts.length === 0) break;
      // Heartbeat: the stall reconcile re-enqueues a "sending" broadcast whose
      // row has not moved in fifteen minutes, so a long walk touches it once
      // per page. The status guard also stops a run whose twin already
      // finished the broadcast, or a cancel.
      const [alive] = await db
        .update(schema.broadcasts)
        .set({ updatedAt: new Date(), fanOutCursor: cursor, ...skippedSet() })
        .where(and(eq(schema.broadcasts.id, broadcast.id), eq(schema.broadcasts.status, "sending")))
        .returning({ id: schema.broadcasts.id });
      if (!alive) {
        await stopIfCanceled(db, broadcast);
        return "skipped";
      }
      skipped = 0;
      deps.sesQuota?.progress(broadcast.id, emitted);
      // A suspension or pause landing mid-walk stops the fan-out at the page
      // edge; the resumed walk skips the contacts already inserted.
      const standingNow = await fetchTeamStanding(db, broadcast.teamId);
      if (standingNow?.suspended || standingNow?.broadcastsPausedByOperatorAt) {
        await deps.reschedule?.(broadcast.id, new Date(Date.now() + REGION_HOLD_RETRY_MS));
        return "deferred";
      }
      const pageSpacingMs = broadcastSendSpacingMs(
        (await fetchDeliverabilityHealth(db, broadcast.teamId)).status,
      );
      if (pageSpacingMs > spacingMs) {
        spacingMs = pageSpacingMs;
        nextSendMs = Math.max(nextSendMs, Date.now());
      }

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
      const batch: EmailSendRequest[] = [];
      for (const contact of contacts) {
        if (suppressed.has(contact.email)) continue;
        if (
          broadcast.topicId &&
          !isSubscribedToTopic(topicOverrides.get(contact.id), topicDefault ?? false)
        ) {
          continue;
        }
        let sendOrder: number | null = null;
        if (warming) {
          const activity = contactActivity(
            warming,
            {
              engagedAt: contact.lastEngagedAt,
              transactionalAt: transactional?.get(contact.email.toLowerCase()) ?? null,
              propertyAt: contact.propertyAt,
            },
            walkStart,
          );
          if (skipInactive && isInactiveContact(activity, walkStart)) {
            skipped += 1;
            continue;
          }
          sendOrder = warmupSendOrder(activity, walkStart);
        }
        // The row id is minted before the body so the unsubscribe link can name
        // the email it sits in.
        const emailId = randomUUID();
        const token = makeUnsubscribeToken({
          contactId: contact.id,
          topicId: broadcast.topicId,
          emailId,
          secretKey: deps.unsubscribeSecretKey,
        });
        const headers = buildUnsubscribeHeaders(deps.unsubscribeBaseUrl, token);
        // "<url>" → url; reusing the header builder keeps link and header
        // pointing at the exact same page.
        const unsubscribeUrl = headers["List-Unsubscribe"].slice(1, -1);
        // Unsubscribe first: replaced segments are not rescanned, so a hostile
        // contact field containing the token can never inject the URL swap.
        const personalize = (s: string | null, opts: { html: boolean }) =>
          s === null
            ? null
            : applyMergeFields(substituteUnsubscribeUrl(s, unsubscribeUrl), contact, opts);
        const encrypted = await encryptEmailBody(
          {
            html: personalize(baseHtml, { html: true }),
            text: personalize(broadcast.text, { html: false }),
          },
          deps.keyring,
          { teamId: broadcast.teamId, rowId: emailId },
        );
        // Only rows this run actually enqueues advance the drip — re-run
        // conflicts (accepted === null) don't, so a resumed fan-out keeps
        // spacing tight instead of leaving gaps for already-queued contacts.
        const startAfter = spacingMs > 0 ? new Date(nextSendMs) : undefined;
        // Past the share's room the row parks at once: no reservation and no
        // job, the drain reserves on release (the existing parking contract).
        // While the judge cannot answer for a young domain's broadcast, every
        // row waits for an operator instead.
        const paced = emitted >= admitted && screenParked === null;
        const held = !paced && screenParked === null && warmupFull;
        // Quota reservation and email insert commit atomically (the quota
        // contract), same as the API accept path — a broadcast must not
        // bypass the plan's cap.
        const firstCopy = screenFirstCopy;
        const judgeNow: string[] = [];
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
              subject: applyMergeFields(broadcast.subject, contact, { html: false }),
              latestStatus: paced || held || screenParked ? "queued_quota" : "queued",
              parkReason: screenParked ?? (held || warming ? "warmup" : null),
              parkedAt: screenParked ? new Date() : null,
              sendOrder,
              // The drip lives on the row: the send handler defers to it and
              // the reconcile sweep leaves a not-yet-due row alone instead of
              // re-enqueueing every throttled send each pass.
              scheduledAt: paced || screenParked ? null : (startAfter ?? null),
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
          // The copy that waits for its own verdict is written with its
          // sample or not at all: without one it would go out unscreened.
          if (firstCopy && deps.monitor) {
            await recordMonitorSample(
              tx as unknown as Db,
              { ...deps.monitor, enqueueJudge: async (id) => void judgeNow.push(id) },
              await deps.monitor.settings(),
              {
                teamId: broadcast.teamId,
                emailId: row.id,
                broadcastId: broadcast.id,
                kind: "broadcast_copy",
                now: new Date(),
                screening: true,
              },
            );
          }
          if (paced || held || screenParked) return { id: row.id, parked: true };
          const txDb = tx as unknown as Db;
          const reservation = await reserveQuota(txDb, {
            teamId: broadcast.teamId,
            count: 1,
            quota,
          });
          if (reservation.reserved) {
            if (!warmup || (await reserveWarmup(txDb, warmup, 1, utcDay())).reserved) {
              return { id: row.id, parked: false };
            }
            // Over the warm-up: the plan's unit goes back, the row parks for
            // the drain, which charges them all again on release.
            await releaseQuota(txDb, { teamId: broadcast.teamId, count: 1, quota });
            await tx
              .update(schema.emails)
              .set({ latestStatus: "queued_quota", parkReason: "warmup" })
              .where(eq(schema.emails.id, row.id));
            warmupFull = true;
            return { id: row.id, parked: true };
          }
          // Over the plan cap: park as queued_quota — accepted but not
          // enqueued; the quota drain moves it to queued once the cap has
          // room again (the UTC rollover, the period renewal, overage on).
          await tx
            .update(schema.emails)
            .set({ latestStatus: "queued_quota" })
            .where(eq(schema.emails.id, row.id));
          return { id: row.id, parked: true };
        });
        // null → this contact was fanned out by a previous run; its job is
        // already queued (or the sends.reconcile sweep recovers it).
        if (accepted && !accepted.parked) {
          emitted += 1;
          nextSendMs += spacingMs;
          batch.push({ emailId: accepted.id, startAfter });
        }
        if (accepted && firstCopy && deps.monitor) {
          screenFirstCopy = false;
          for (const sampleId of judgeNow) {
            await deps.monitor.enqueueJudge(sampleId, {
              teamId: broadcast.teamId,
              screening: true,
            });
          }
        } else if (
          accepted &&
          deps.monitor &&
          monitorCopies > 0 &&
          drawBroadcastCopy(
            deps.monitor.samplingKey,
            broadcast.id,
            accepted.id,
            monitorCopies,
            monitorAudience,
          )
        ) {
          try {
            await recordMonitorSample(db, deps.monitor, await deps.monitor.settings(), {
              teamId: broadcast.teamId,
              emailId: accepted.id,
              broadcastId: broadcast.id,
              kind: "broadcast_copy",
              now: new Date(),
            });
          } catch (err) {
            console.error(`broadcast ${broadcast.id}: monitor copy skipped`, err);
          }
        }
      }
      // One statement per page: the rows are committed, so a failed enqueue
      // only delays them until the sends.reconcile sweep.
      if (batch.length > 0) {
        try {
          await deps.enqueueEmailSends(batch);
        } catch (err) {
          console.error("email.send enqueue failed; reconcile sweep will recover", err);
        }
      }
      cursor = contacts[contacts.length - 1]?.id ?? cursor;
    }

    // The walk is done, the send is not: recipientCount marks the walk's end
    // and the status flips only once every row has gone (finalizeBroadcast),
    // which the drain and the reconcile sweep call again for a paced send.
    [walked] = await db
      .update(schema.broadcasts)
      .set({
        updatedAt: new Date(),
        fanOutCursor: null,
        // Counted once here off the fan-out's own unique index, so lists never
        // join the emails table to size a broadcast.
        recipientCount: sql`(select count(*)::int from ${schema.emails} where ${schema.emails.broadcastId} = ${broadcast.id})`,
        ...skippedSet(),
      })
      .where(and(eq(schema.broadcasts.id, broadcast.id), eq(schema.broadcasts.status, "sending")))
      .returning({ recipientCount: schema.broadcasts.recipientCount });
  } finally {
    deps.sesQuota?.progress(broadcast.id, emitted);
    deps.sesQuota?.done(broadcast.id);
  }
  if (!walked) {
    await stopIfCanceled(db, broadcast);
    return "skipped";
  }
  if (!(await finalizeBroadcast(db, deps, broadcast.id))) {
    if (warming) {
      await reportWarmupWalkEnd(db, deps, broadcast, { id: domain.id, name: fromDomain });
    } else {
      await reportWalkEnd(db, deps, broadcast, domain.region, walked.recipientCount ?? 0, quota);
    }
  }
  return "sent";
}

/** Whether a fan-out already rendered the copy that waits for its own verdict. */
async function firstCopyScreened(db: Db, broadcastId: string): Promise<boolean> {
  const ms = schema.monitorSamples;
  const [row] = await db
    .select({ id: ms.id })
    .from(ms)
    .where(
      and(eq(ms.broadcastId, broadcastId), eq(ms.kind, "broadcast_copy"), eq(ms.screening, true)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A walk that lost its status CAS to a stop: rows the last page committed
 * after the stop's own sweep are canceled the same way, and their
 * reservations go back. Idempotent, so a page that raced is the only cost.
 */
async function stopIfCanceled(db: Db, broadcast: { id: string; teamId: string }): Promise<void> {
  const [row] = await db
    .select({ status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcast.id));
  if (row?.status === "canceled") {
    await cancelBroadcastRows(db, { broadcastId: broadcast.id, teamId: broadcast.teamId });
  }
}

/**
 * The end of a send: once no row of the broadcast is queued or parked, the
 * status flips to sent and the owners get the report, claimed once per
 * broadcast however many callers (the walk, the drain, the reconcile sweep)
 * arrive. False while rows remain, or when the broadcast is no longer
 * sending.
 */
export async function finalizeBroadcast(
  db: Db,
  deps: Pick<BroadcastDeps, "mailer" | "appBaseUrl">,
  broadcastId: string,
): Promise<boolean> {
  const e = schema.emails;
  // One statement, one snapshot (a row parking between two probes would read
  // as gone), and one EXISTS per state so each uses its partial index.
  const [probe] = await db
    .select({
      open: sql<boolean>`exists (select 1 from ${e} where ${e.broadcastId} = ${broadcastId} and ${e.latestStatus} = 'queued_quota')
        or exists (select 1 from ${e} where ${e.broadcastId} = ${broadcastId} and ${e.latestStatus} = 'queued')`,
    })
    .from(sql`(select 1) as one`);
  if (probe?.open) return false;
  // Only a finished walk (recipientCount set) can complete: a crashed walk
  // whose written rows all went out is still re-kicked, not sent.
  const [done] = await db
    .update(schema.broadcasts)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.broadcasts.id, broadcastId),
        eq(schema.broadcasts.status, "sending"),
        isNotNull(schema.broadcasts.recipientCount),
      ),
    )
    .returning({
      id: schema.broadcasts.id,
      teamId: schema.broadcasts.teamId,
      name: schema.broadcasts.name,
      subject: schema.broadcasts.subject,
      recipientCount: schema.broadcasts.recipientCount,
    });
  if (!done) return false;
  if (
    !deps.mailer ||
    !(await claimNotification(db, {
      teamId: done.teamId,
      kind: "broadcast.sent",
      periodKey: done.id,
    }))
  ) {
    return true;
  }
  const [{ failed } = { failed: 0 }] = await db
    .select({ failed: sql<number>`count(*)::int` })
    .from(e)
    .where(and(eq(e.broadcastId, broadcastId), eq(e.latestStatus, "failed")));
  const count = done.recipientCount ?? 0;
  await report(db, deps, done, "broadcast.sent", `/broadcasts/${done.id}`, (locale, team) => ({
    name: done.name ?? done.subject,
    subject: done.subject,
    team,
    count: count.toLocaleString(locale),
    failed:
      failed > 0
        ? accountMailPhrase({
            locale,
            kind: "broadcast.sent",
            key: "failed",
            values: { n: failed.toLocaleString(locale) },
          })
        : "",
  }));
  return true;
}

/**
 * What the owners hear when the walk ends with rows still waiting: the
 * plan's cap holds them (today's quota notice), or the platform's capacity
 * does (the pacing note with the planner's estimate). Each claimed once per
 * broadcast, apart from the completion report.
 */
async function reportWalkEnd(
  db: Db,
  deps: BroadcastDeps,
  broadcast: { id: string; teamId: string; name: string | null; subject: string },
  region: string,
  count: number,
  quota: NonNullable<Awaited<ReturnType<typeof fetchTeamQuota>>>,
): Promise<void> {
  if (!deps.mailer) return;
  // Rows a domain's warm-up holds are left out: neither the plan nor the
  // platform's capacity is why they wait, and the domain page says when.
  const [{ parked } = { parked: 0 }] = await db
    .select({ parked: sql<number>`count(*)::int` })
    .from(schema.emails)
    .where(
      and(
        eq(schema.emails.broadcastId, broadcast.id),
        eq(schema.emails.latestStatus, "queued_quota"),
        isNull(schema.emails.parkReason),
      ),
    );
  if (parked === 0) return;
  const name = broadcast.name ?? broadcast.subject;
  const now = new Date();
  const capRoom = Math.min(
    ...planCaps(quota, await quotaUsage(db, broadcast.teamId, quota, now), now).map(
      (cap) => cap.remaining,
    ),
  );
  if (capRoom <= 0) {
    const kind = "broadcast.held_quota";
    if (!(await claimNotification(db, { teamId: broadcast.teamId, kind, periodKey: broadcast.id })))
      return;
    const limit = quota.kind === "month" ? quota.included : quota.kind === "day" ? quota.limit : 0;
    await report(db, deps, broadcast, kind, "/settings/billing", (locale, team) => ({
      name,
      team,
      count: count.toLocaleString(locale),
      parked: parked.toLocaleString(locale),
      sent: (count - parked).toLocaleString(locale),
      limit: limit.toLocaleString(locale),
      release:
        quota.kind === "month"
          ? accountMailPhrase({
              locale,
              kind,
              key: quota.overagePaused ? "releasePaused" : "releaseMonthly",
              values: { date: formatMailDate(locale, quota.periodEnd) },
            })
          : accountMailPhrase({
              locale,
              kind,
              key: "releaseDaily",
              values: { resetsAt: nextUtcDayStart(now).toISOString().slice(11, 16) },
            }),
    }));
    return;
  }
  const capacity = deps.sesQuota?.capacity(region);
  if (!deps.sesQuota || !capacity) {
    console.warn(`broadcast ${broadcast.id}: ${parked} rows paced, no SES capacity known yet`);
    return;
  }
  const plan = await planRegionSend(db, {
    region,
    account: capacity,
    reservePercent: deps.sesQuota.reserve(),
    rateCeiling: deps.sesQuota.rate(region),
    horizonDays: deps.horizonDays
      ? await deps.horizonDays()
      : pacingHorizonDays(PACING_HORIZON_MAX_RETENTION_DAYS),
    now,
  });
  const mine = plan.estimates.find((estimate) => estimate.key === broadcast.id);
  if (!mine?.finishesAt) {
    console.warn(`broadcast ${broadcast.id}: ${parked} rows paced past the horizon`);
    return;
  }
  // The rest goes out within the day: the completion report is news enough.
  if (mine.days <= 1) return;
  const finishesAt = roundUpToSlot(mine.finishesAt);
  await reportSending(db, deps, broadcast, mine.days, (locale) =>
    accountMailPhrase({
      locale,
      kind: "broadcast.sending",
      key: "wave",
      values: {
        first: (count - parked).toLocaleString(locale),
        count: count.toLocaleString(locale),
        finishesAt: formatMailDateTime(locale, finishesAt),
      },
    }),
  );
}

/**
 * The walk-end note for a warming domain's broadcast, from the warm-up's
 * own plan rather than the platform's capacity: none while the warm-up is
 * paused, nor when the rest goes out within the day.
 */
async function reportWarmupWalkEnd(
  db: Db,
  deps: BroadcastDeps,
  broadcast: { id: string; teamId: string; name: string | null; subject: string },
  domain: { id: string; name: string },
): Promise<void> {
  if (!deps.mailer) return;
  const [{ waiting } = { waiting: 0 }] = await db
    .select({ waiting: sql<number>`count(*)::int` })
    .from(schema.emails)
    .where(
      and(
        eq(schema.emails.broadcastId, broadcast.id),
        eq(schema.emails.latestStatus, "queued_quota"),
        eq(schema.emails.parkReason, "warmup"),
      ),
    );
  if (waiting === 0) return;
  const plan = await planDomainWarmup(db, {
    teamId: broadcast.teamId,
    domainId: domain.id,
    count: waiting,
    broadcastId: broadcast.id,
  });
  if (!plan?.finishesAt || plan.days <= 1) return;
  const finishesAt = roundUpToSlot(plan.finishesAt);
  await reportSending(db, deps, broadcast, plan.days, (locale) =>
    accountMailPhrase({
      locale,
      kind: "broadcast.sending",
      key: "warmup",
      values: { domain: domain.name, finishesAt: formatMailDateTime(locale, finishesAt) },
    }),
  );
}

/** The note that a send takes `days`, claimed once per broadcast; `progress` says how it goes out. */
async function reportSending(
  db: Db,
  deps: BroadcastDeps,
  broadcast: { id: string; teamId: string; name: string | null; subject: string },
  days: number,
  progress: (locale: MailLocale) => string,
): Promise<void> {
  const kind = "broadcast.sending";
  if (!(await claimNotification(db, { teamId: broadcast.teamId, kind, periodKey: broadcast.id }))) {
    return;
  }
  await report(db, deps, broadcast, kind, `/broadcasts/${broadcast.id}`, (locale, team) => ({
    team,
    days: String(days),
    progress: progress(locale),
  }));
}
