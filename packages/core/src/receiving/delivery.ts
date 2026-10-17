import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import type { Keyring } from "../crypto/keyring.js";
import {
  encodeInboxActor,
  type InboxActor,
  recordInboxActivity,
  touchInbox,
} from "../inboxes/activity.js";
import { emailQuarantinedEvent, threadEmailEvent, threadFolderEvent } from "../inboxes/events.js";
import { INBOX_ALLOWLIST_MAX } from "../inboxes/limits.js";
import { releaseRights, screensOnRelease } from "../inboxes/release-rules.js";
import { secondsToNextUtcDay } from "../inboxes/send-policy.js";
import { threadSummaryOf } from "../inboxes/threads.js";
import type { InboxKind, QuarantineReason, SenderTrust } from "../inboxes/types.js";
import { inboundThreadEmailWire } from "../inboxes/wire.js";
import { instanceSettings } from "../monitor-settings.js";
import { utcDay } from "../utc-day.js";
import {
  enqueueTeamWebhookEvents,
  type QueuedWebhookDelivery,
  type TeamWebhookEvent,
  type WebhookEnqueue,
} from "../webhooks.js";
import {
  openReceivedAttachments,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedAttachment,
  type ReceivedEmailMeta,
  receivedEmailEventData,
} from "./message.js";
import { receivedEmailVisible } from "./rcpt.js";
import { heldReason, type InboundJudgeRun, judgeReceived, type ReleaseScreen } from "./screen.js";

export interface DeliveryDeps {
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
  enqueueInboxForward?:
    | ((p: { receivedEmailId: string; inboxId: string }) => Promise<void>)
    | undefined;
  /** Opens the sealed attachment list the event emails name; without it they list none. */
  keyring?: Keyring | undefined;
  /**
   * The judge a release asks first, with the keyring; without it a person's
   * release goes unscreened and an agent's is refused.
   */
  screen?: ReleaseScreen | undefined;
}

type Membership = typeof schema.receivedEmailInboxes.$inferSelect;
type MembershipKey = { receivedEmailId: string; inboxId: string };

/** What a delivering transaction leaves to do once it has committed. */
export interface AfterCommit {
  deliveries: QueuedWebhookDelivery[];
  forwards: MembershipKey[];
  screens: MembershipKey[];
}

export const afterCommit = (): AfterCommit => ({ deliveries: [], forwards: [], screens: [] });

/**
 * Hands committed rows to the queues. A failed hand-off only delays them:
 * webhooks.reconcile sends the deliveries and sends.reconcile re-enqueues
 * pending screenings; a lost forward is logged.
 */
export async function runAfterCommit(
  deps: {
    enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
    enqueueScreening?: ((p: MembershipKey) => Promise<void>) | undefined;
    enqueueInboxForward?: ((p: MembershipKey) => Promise<void>) | undefined;
  },
  after: AfterCommit,
): Promise<void> {
  const tryEach = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      console.warn(
        `receiving: ${what} enqueue failed (${err instanceof Error ? err.name : "error"})`,
      );
    }
  };
  const { enqueueWebhookDeliveries, enqueueScreening, enqueueInboxForward } = deps;
  if (enqueueWebhookDeliveries && after.deliveries.length > 0) {
    await tryEach("webhook", () => enqueueWebhookDeliveries(after.deliveries));
  }
  if (enqueueScreening) {
    for (const job of after.screens) await tryEach("screening", () => enqueueScreening(job));
  }
  if (enqueueInboxForward) {
    for (const job of after.forwards) await tryEach("forward", () => enqueueInboxForward(job));
  }
}

const emit = (tx: Db, teamId: string, events: TeamWebhookEvent[], after: AfterCommit) =>
  enqueueTeamWebhookEvents(tx, {
    teamId,
    events,
    enqueue: async (rows) => {
      after.deliveries.push(...rows);
    },
  });

/** The inbox ids a row was delivered into, for webhook endpoints filtered by inbox. */
async function deliveredInboxIds(db: Db, receivedEmailId: string): Promise<string[]> {
  const m = schema.receivedEmailInboxes;
  const rows = await db
    .select({ inboxId: m.inboxId })
    .from(m)
    .where(and(eq(m.receivedEmailId, receivedEmailId), isNotNull(m.deliveredAt)));
  return rows.map((r) => r.inboxId);
}

/**
 * email.received for a row that just became visible (a catch-all row, or
 * its first delivered membership), once: announced_at is its only emitter's
 * claim, so ingest, screening and release can each try.
 */
export async function announceIfVisible(
  tx: Db,
  p: {
    row: ReceivedEmailMeta;
    attachments: readonly ReceivedAttachment[];
    now: Date;
    after: AfterCommit;
  },
): Promise<boolean> {
  const r = schema.receivedEmails;
  const [claimed] = await tx
    .update(r)
    .set({ announcedAt: p.now })
    .where(and(eq(r.id, p.row.id), isNull(r.announcedAt), receivedEmailVisible()))
    .returning({ id: r.id });
  if (!claimed) return false;
  await emit(
    tx,
    p.row.teamId,
    [
      {
        type: "email.received",
        occurredAt: p.now,
        data: receivedEmailEventData(p.row, p.attachments),
        inboxIds: await deliveredInboxIds(tx, p.row.id),
      },
    ],
    p.after,
  );
  return true;
}

/** The event email of a received message: metadata only, the attachments named when known. */
function eventEmail(
  row: ReceivedEmailMeta,
  membership: Membership,
  attachments: readonly ReceivedAttachment[],
) {
  return inboundThreadEmailWire(row, membership, {
    html: null,
    text: null,
    extractedText: null,
    attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
  });
}

/**
 * A held or pending membership becomes visible to agents: delivered (or
 * released, which reads as delivered), its thread moved back to the inbox
 * from archive or sent unless the message is spam, the sender recorded as a
 * correspondent, and the inbox.* events queued. The caller announces the row
 * (announceIfVisible) once its memberships are settled. `from` guards the
 * transition, so a second run changes nothing. Returns the membership as
 * delivered, or null when it was not in that state.
 */
export async function markDelivered(
  tx: Db,
  p: {
    row: ReceivedEmailMeta;
    key: MembershipKey;
    from: "pending" | "quarantined";
    set: Partial<
      Pick<
        Membership,
        | "verdict"
        | "reasons"
        | "injectionScore"
        | "phishingScore"
        | "judge"
        | "releasedAt"
        | "releasedBy"
      >
    >;
    /**
     * Spam: a thread it opens is filed as spam, a live thread keeps its
     * folder, and no copy is forwarded.
     */
    spam: boolean;
    forwardTo: readonly string[];
    attachments: readonly ReceivedAttachment[];
    now: Date;
    after: AfterCommit;
  },
): Promise<Membership | null> {
  const m = schema.receivedEmailInboxes;
  const [membership] = await tx
    .update(m)
    .set({ ...p.set, deliveredAt: p.now })
    .where(
      and(
        eq(m.receivedEmailId, p.key.receivedEmailId),
        eq(m.inboxId, p.key.inboxId),
        eq(m.verdict, p.from),
        isNull(m.deliveredAt),
      ),
    )
    .returning();
  if (!membership) return null;
  // Delivered mail is use, so an inbox read only through webhooks stays; spam
  // isn't, or anyone could keep an inbox alive by mailing it.
  if (!p.spam) await touchInbox(tx, p.key.inboxId, p.now);
  const t = schema.inboxThreads;
  const [thread] = await tx
    .select({ id: t.id, folder: t.folder })
    .from(t)
    .where(eq(t.id, membership.threadId))
    .for("update");
  if (!thread) throw new Error("inbox thread missing");
  const first = await tx
    .select({
      earlier: sql<boolean>`exists (select 1 from ${m} where ${m.threadId} = ${thread.id} and ${m.deliveredAt} is not null and ${m.receivedEmailId} <> ${membership.receivedEmailId})
        or exists (select 1 from ${schema.emails} where ${schema.emails.threadId} = ${thread.id})`,
    })
    .from(t)
    .where(eq(t.id, thread.id));
  const isFirst = !first[0]?.earlier;
  // Spam that opens a thread files the thread as spam; in a live thread it stays put.
  const to = p.spam
    ? isFirst && thread.folder === "inbox"
      ? ("spam" as const)
      : null
    : thread.folder === "archive" || thread.folder === "sent"
      ? ("inbox" as const)
      : null;
  const moved = to !== null && !isFirst;
  await tx
    .update(t)
    .set({
      lastMessageAt: p.now,
      subject: sql`coalesce(nullif(${t.subject}, ''), ${p.row.subject})`,
      ...(to ? { folder: to, trashedAt: null } : {}),
    })
    .where(eq(t.id, thread.id));
  const from = p.row.from.toLowerCase();
  // A From anyone could have forged must not make its address a known correspondent.
  if (from && membership.senderTrust !== "unauthenticated" && membership.senderTrust !== "failed") {
    const c = schema.inboxCorrespondents;
    await tx
      .insert(c)
      .values({ inboxId: p.key.inboxId, address: from, firstInAt: p.now, lastSeenAt: p.now })
      .onConflictDoUpdate({
        target: [c.inboxId, c.address],
        set: { firstInAt: sql`coalesce(${c.firstInAt}, ${p.now})`, lastSeenAt: p.now },
      });
  }
  const summary = await threadSummaryOf(tx, thread.id);
  if (!summary) throw new Error("inbox thread missing");
  const email = eventEmail(p.row, membership, p.attachments);
  const events: TeamWebhookEvent[] = [];
  if (moved && to) {
    events.push(
      threadFolderEvent({
        source: "system",
        inboxId: p.key.inboxId,
        thread: summary,
        from: thread.folder,
        to,
        occurredAt: p.now,
      }),
    );
  }
  if (isFirst) {
    events.push(
      threadEmailEvent("inbox.thread.created", {
        inboxId: p.key.inboxId,
        thread: summary,
        email,
        occurredAt: p.now,
      }),
    );
  }
  events.push(
    threadEmailEvent("inbox.email.received", {
      inboxId: p.key.inboxId,
      thread: summary,
      email,
      occurredAt: p.now,
    }),
  );
  await emit(tx, p.row.teamId, events, p.after);
  // Spam stays here: forwarded, it would reach a member's own mailbox signed
  // by our domain, a forged sender's included.
  if (p.forwardTo.length > 0 && !p.spam) p.after.forwards.push(p.key);
  return membership;
}

/** A pending membership held: quarantined with its reason, inbox.email.quarantined queued, the action recorded. */
export async function markQuarantined(
  tx: Db,
  p: {
    row: ReceivedEmailMeta;
    key: MembershipKey;
    reason: QuarantineReason;
    set?:
      | Partial<Pick<Membership, "reasons" | "injectionScore" | "phishingScore" | "judge">>
      | undefined;
    now: Date;
    after: AfterCommit;
  },
): Promise<Membership | null> {
  const m = schema.receivedEmailInboxes;
  const [membership] = await tx
    .update(m)
    .set({ ...p.set, verdict: "quarantined", quarantineReason: p.reason, quarantinedAt: p.now })
    .where(
      and(
        eq(m.receivedEmailId, p.key.receivedEmailId),
        eq(m.inboxId, p.key.inboxId),
        eq(m.verdict, "pending"),
      ),
    )
    .returning();
  if (!membership) return null;
  await emit(
    tx,
    p.row.teamId,
    [
      emailQuarantinedEvent({
        inboxId: p.key.inboxId,
        threadId: membership.threadId,
        emailId: p.row.id,
        reason: p.reason,
        senderTrust: membership.senderTrust,
        from: p.row.from,
        subject: p.row.subject === "" ? null : p.row.subject,
        receivedAt: p.row.createdAt,
        occurredAt: p.now,
      }),
    ],
    p.after,
  );
  await recordInboxActivity(tx, {
    teamId: p.row.teamId,
    inboxId: p.key.inboxId,
    actor: { kind: "system" },
    action: "email.quarantined",
    threadId: membership.threadId,
    emailId: p.row.id,
    decision: { result: "quarantined", reasons: [p.reason] },
  });
  return membership;
}

/** Counts one received membership toward the inbox's day. */
export async function bumpInboxReceived(tx: Db, inboxId: string, now: Date): Promise<void> {
  const u = schema.inboxUsageDaily;
  await tx
    .insert(u)
    .values({ inboxId, day: utcDay(now), received: 1 })
    .onConflictDoUpdate({ target: [u.inboxId, u.day], set: { received: sql`${u.received} + 1` } });
}

export type ReleaseRefusal =
  | "not_found"
  | "not_quarantined"
  | "allowlist_full"
  | "forbidden"
  | "trust_not_allowed"
  | "screening_unavailable";

export type ReleaseResult =
  | { ok: true; outcome: "released"; releasedAt: Date; trustedSender: string | null }
  | {
      ok: true;
      outcome: "held_again";
      reason: QuarantineReason;
      injectionScore: number | null;
      phishingScore: number | null;
    }
  | {
      ok: false;
      reason: ReleaseRefusal;
      /** screening_unavailable: seconds until screening may run again. */
      retryAfterSec?: number | undefined;
    };

/**
 * The judge's run on a hold that a release would deliver unscreened, or
 * null when none is due (no judge, a hold the release doesn't screen, an
 * actor it refuses) or the judge couldn't run. It runs ahead of the
 * release's transaction, so no lock waits on the judge; the transaction
 * checks the hold is still the one judged.
 */
async function judgeBeforeRelease(
  db: Db,
  deps: DeliveryDeps,
  p: {
    teamId: string;
    receivedEmailId: string;
    inboxId: string;
    now: Date;
    /** Whether this release of the hold, as it stands, asks the judge first. */
    screens: (hold: {
      reason: QuarantineReason;
      senderTrust: SenderTrust;
      kind: InboxKind;
      screening: boolean;
    }) => boolean;
  },
): Promise<{ reason: QuarantineReason; run: InboundJudgeRun } | null> {
  const { screen, keyring } = deps;
  if (!screen || !keyring) return null;
  const m = schema.receivedEmailInboxes;
  const i = schema.inboxes;
  const [held] = await db
    .select({
      verdict: m.verdict,
      reason: m.quarantineReason,
      senderTrust: m.senderTrust,
      kind: i.kind,
      safety: i.safety,
    })
    .from(m)
    .innerJoin(i, eq(i.id, m.inboxId))
    .where(
      and(
        eq(m.receivedEmailId, p.receivedEmailId),
        eq(m.inboxId, p.inboxId),
        eq(m.teamId, p.teamId),
      ),
    );
  if (held?.verdict !== "quarantined") return null;
  const reason = held.reason ?? "unscreened";
  if (
    !p.screens({
      reason,
      senderTrust: held.senderTrust,
      kind: held.kind,
      screening: held.safety.screening,
    })
  ) {
    return null;
  }
  const r = schema.receivedEmails;
  const [row] = await db.select().from(r).where(eq(r.id, p.receivedEmailId));
  if (!row) return null;
  try {
    const run = await judgeReceived(
      db,
      {
        judge: screen.judge,
        keyring,
        settings: await instanceSettings(db, { monitorSettings: screen.settings }),
        timeoutMs: screen.timeoutMs,
        // The releaser waits on the answer: one quick retry rides out a passing throttle.
        retries: 1,
        backoffMs: 250,
      },
      { row, tier: held.senderTrust, inboxId: p.inboxId, now: p.now },
    );
    return { reason, run };
  } catch (err) {
    console.warn(
      `release: screening of ${p.receivedEmailId} failed (${err instanceof Error ? err.name : "error"})`,
    );
    return null;
  }
}

/**
 * Releases held mail, where releaseRights lets the actor. With an inbox: a
 * quarantined membership is delivered with verdict released (its events
 * and the row's announcement as a delivery would bring), never judged
 * again; trustSender also allowlists the From address. The judge reads a
 * hold first, against the line inbound mail meets, when a person or a team
 * key releases one made before screening (screensOnRelease) and whenever
 * an agent credential releases: at the line, the message stays held for
 * what the judge found (held_again). A judge that can't answer (none, a
 * failure, a spent cap) leaves a person's or a team key's decision
 * standing, and refuses an agent's release (screening_unavailable). A hold
 * that changed since it was reviewed (`reviewed`) or judged answers
 * held_again as it now stands. Without an inbox: a catch-all row held for a
 * virus becomes visible. A virus release still never serves the files or
 * the raw message.
 */
export async function releaseQuarantined(
  db: Db,
  deps: DeliveryDeps,
  p: {
    teamId: string;
    receivedEmailId: string;
    inboxId: string | null;
    actor: InboxActor;
    /** The person releasing is an owner or admin. */
    admin?: boolean | undefined;
    /** The hold the person read before releasing, as the release dialog showed it. */
    reviewed?: QuarantineReason | undefined;
    trustSender: boolean;
    now?: Date | undefined;
  },
): Promise<ReleaseResult> {
  const now = p.now ?? new Date();
  const after = afterCommit();
  const r = schema.receivedEmails;
  const releasedBy = encodeInboxActor(p.actor);
  const rights = (reason: QuarantineReason, senderTrust: SenderTrust) =>
    releaseRights({ reason, senderTrust, actor: p.actor, inboxId: p.inboxId, admin: p.admin });
  const refusal = (may: ReturnType<typeof releaseRights>): ReleaseRefusal | null => {
    if (!may.release) return "forbidden";
    return p.trustSender && !may.trust ? "trust_not_allowed" : null;
  };
  const judged =
    p.inboxId === null
      ? null
      : await judgeBeforeRelease(db, deps, {
          teamId: p.teamId,
          receivedEmailId: p.receivedEmailId,
          inboxId: p.inboxId,
          now,
          screens: (hold) => {
            const may = rights(hold.reason, hold.senderTrust);
            return refusal(may) === null && (may.needsVerdict || screensOnRelease(hold));
          },
        });
  const outcome = await db.transaction(async (raw): Promise<ReleaseResult> => {
    const tx = raw as unknown as Db;
    const [row] = await tx
      .select(RECEIVED_EMAIL_META_COLUMNS)
      .from(r)
      .where(and(eq(r.id, p.receivedEmailId), eq(r.teamId, p.teamId)))
      .for("update");
    if (!row) return { ok: false, reason: "not_found" };
    // A list that can't be opened (corrupt, an unknown key version) only leaves the events naming none.
    const attachments = deps.keyring
      ? await openReceivedAttachments(row, deps.keyring).catch(() => [])
      : [];
    if (p.inboxId === null) {
      if (!row.catchAll || row.virusVerdict !== "fail") return { ok: false, reason: "not_found" };
      if (row.releasedAt) return { ok: false, reason: "not_quarantined" };
      const refused = refusal(rights("virus", row.senderTrust));
      if (refused) return { ok: false, reason: refused };
      const [released] = await tx
        .update(r)
        .set({ releasedAt: now, releasedBy })
        .where(eq(r.id, row.id))
        .returning(RECEIVED_EMAIL_META_COLUMNS);
      if (!released) throw new Error("received_emails update returned no row");
      await announceIfVisible(tx, { row: released, attachments, now, after });
      return { ok: true, outcome: "released", releasedAt: now, trustedSender: null };
    }
    const m = schema.receivedEmailInboxes;
    const [membership] = await tx
      .select({
        verdict: m.verdict,
        threadId: m.threadId,
        reason: m.quarantineReason,
        senderTrust: m.senderTrust,
        injectionScore: m.injectionScore,
        phishingScore: m.phishingScore,
      })
      .from(m)
      .where(and(eq(m.receivedEmailId, row.id), eq(m.inboxId, p.inboxId), eq(m.teamId, p.teamId)))
      .for("update");
    if (!membership) return { ok: false, reason: "not_found" };
    if (membership.verdict !== "quarantined") return { ok: false, reason: "not_quarantined" };
    const reason = membership.reason ?? "unscreened";
    // Another release's screening held it again since it was read or judged:
    // that verdict stands, never released on a reading of the old hold.
    if ((p.reviewed ?? reason) !== reason || (judged && judged.reason !== reason)) {
      return {
        ok: true,
        outcome: "held_again",
        reason,
        injectionScore: membership.injectionScore,
        phishingScore: membership.phishingScore,
      };
    }
    const may = rights(reason, membership.senderTrust);
    const refused = refusal(may);
    if (refused) return { ok: false, reason: refused };
    const verdict = judged?.run.verdict ?? null;
    if (may.needsVerdict && !verdict) {
      return {
        ok: false,
        reason: "screening_unavailable",
        // A spent cap resets at midnight UTC; a judge that failed may answer again soon.
        retryAfterSec:
          judged?.run.record.status === "screening_cap" ? secondsToNextUtcDay(now) : 60,
      };
    }
    const scores = verdict
      ? {
          reasons: verdict.reasons,
          injectionScore: verdict.injectionScore,
          phishingScore: verdict.phishingScore,
        }
      : {};
    const screened = judged ? { ...scores, judge: judged.run.record } : {};
    const heldFor = verdict ? heldReason(verdict) : null;
    if (verdict && heldFor) {
      await tx
        .update(m)
        .set({ ...screened, quarantineReason: heldFor })
        .where(and(eq(m.receivedEmailId, row.id), eq(m.inboxId, p.inboxId)));
      await recordInboxActivity(tx, {
        teamId: p.teamId,
        inboxId: p.inboxId,
        actor: { kind: "system" },
        action: "email.quarantined",
        threadId: membership.threadId,
        emailId: row.id,
        decision: { result: "quarantined", reasons: [heldFor] },
      });
      return {
        ok: true,
        outcome: "held_again",
        reason: heldFor,
        injectionScore: verdict.injectionScore,
        phishingScore: verdict.phishingScore,
      };
    }
    const i = schema.inboxes;
    const [inbox] = await tx
      .select({ safety: i.safety })
      .from(i)
      .where(eq(i.id, p.inboxId))
      .for("update");
    if (!inbox) return { ok: false, reason: "not_found" };
    let trustedSender: string | null = null;
    const sender = row.from.toLowerCase();
    if (p.trustSender && sender) {
      if (!inbox.safety.allowlist.includes(sender)) {
        if (inbox.safety.allowlist.length >= INBOX_ALLOWLIST_MAX) {
          return { ok: false, reason: "allowlist_full" };
        }
        await tx
          .update(i)
          .set({
            safety: { ...inbox.safety, allowlist: [...inbox.safety.allowlist, sender] },
            updatedAt: now,
          })
          .where(eq(i.id, p.inboxId));
      }
      trustedSender = sender;
    }
    await markDelivered(tx, {
      row,
      key: { receivedEmailId: row.id, inboxId: p.inboxId },
      from: "quarantined",
      set: { ...screened, verdict: "released", releasedAt: now, releasedBy },
      spam: false,
      forwardTo: inbox.safety.forward_to,
      attachments,
      now,
      after,
    });
    await recordInboxActivity(tx, {
      teamId: p.teamId,
      inboxId: p.inboxId,
      actor: p.actor,
      action: "email.released",
      threadId: membership.threadId,
      emailId: row.id,
      decision: { result: "released", reasons: trustedSender ? ["trust_sender"] : [] },
    });
    await announceIfVisible(tx, { row, attachments, now, after });
    return { ok: true, outcome: "released", releasedAt: now, trustedSender };
  });
  if (!outcome.ok || outcome.outcome === "held_again") return outcome;
  await runAfterCommit(deps, after);
  // A person's release reaches the team's audit trail; a key's stays in the inbox activity.
  if (p.actor.kind === "user") {
    await recordAudit(db, {
      teamId: p.teamId,
      actor: { userId: p.actor.userId },
      action: "inbox.email_released",
      target: { type: "received_email", id: p.receivedEmailId },
      metadata: { inbox_id: p.inboxId, trusted_sender: outcome.trustedSender !== null },
    });
  }
  return outcome;
}

/** Past this a pending screening counts as lost and is queued again. */
const SCREENING_STALL_MS = 15 * 60_000;
const RECONCILE_BATCH = 500;

/**
 * The 15-minute sweep's share of inbound screening: memberships still
 * pending past SCREENING_STALL_MS go back to the received.screen queue (its
 * dedupe key keeps a live job from doubling). Returns how many it queued.
 */
export async function reconcilePendingScreens(
  db: Db,
  enqueue: (p: { receivedEmailId: string; inboxId: string }) => Promise<void>,
  now: Date = new Date(),
): Promise<number> {
  const m = schema.receivedEmailInboxes;
  const stalled = await db
    .select({ receivedEmailId: m.receivedEmailId, inboxId: m.inboxId })
    .from(m)
    .where(
      and(eq(m.verdict, "pending"), lt(m.createdAt, new Date(now.getTime() - SCREENING_STALL_MS))),
    )
    .orderBy(asc(m.createdAt))
    .limit(RECONCILE_BATCH);
  let queued = 0;
  for (const job of stalled) {
    try {
      await enqueue(job);
      queued++;
    } catch (err) {
      console.warn(
        `sends.reconcile: screening enqueue failed (${err instanceof Error ? err.name : "error"})`,
      );
    }
  }
  return queued;
}
