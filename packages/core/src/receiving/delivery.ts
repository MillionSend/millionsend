import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import type { Keyring } from "../crypto/keyring.js";
import { encodeInboxActor, type InboxActor, recordInboxActivity } from "../inboxes/activity.js";
import { emailQuarantinedEvent, threadEmailEvent, threadFolderEvent } from "../inboxes/events.js";
import { INBOX_ALLOWLIST_MAX } from "../inboxes/limits.js";
import { threadSummaryOf } from "../inboxes/threads.js";
import type { QuarantineReason } from "../inboxes/types.js";
import { inboundThreadEmailWire } from "../inboxes/wire.js";
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

export interface DeliveryDeps {
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
  enqueueInboxForward?:
    | ((p: { receivedEmailId: string; inboxId: string }) => Promise<void>)
    | undefined;
  /** Opens the sealed attachment list the event emails name; without it they list none. */
  keyring?: Keyring | undefined;
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
    /** Spam: a thread it opens is filed as spam; a live thread keeps its folder. */
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
    .set({ lastMessageAt: p.now, ...(to ? { folder: to, trashedAt: null } : {}) })
    .where(eq(t.id, thread.id));
  const from = p.row.from.toLowerCase();
  if (from) {
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
  if (p.forwardTo.length > 0) p.after.forwards.push(p.key);
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

/**
 * Releases held mail. With an inbox: a quarantined membership is delivered
 * with verdict released (its events and the row's announcement as a
 * delivery would bring), never judged again; trustSender also allowlists
 * the From address. Without one: a catch-all row held for a virus becomes
 * visible. A virus release still never serves the files or the raw message.
 * Callers check who may release (canApprove, or an MCP token with
 * receiving:manage).
 */
export async function releaseQuarantined(
  db: Db,
  deps: DeliveryDeps,
  p: {
    teamId: string;
    receivedEmailId: string;
    inboxId: string | null;
    actor: InboxActor;
    trustSender: boolean;
    now?: Date | undefined;
  },
): Promise<
  | { ok: true; releasedAt: Date; trustedSender: string | null }
  | { ok: false; reason: "not_found" | "not_quarantined" | "allowlist_full" }
> {
  const now = p.now ?? new Date();
  const after = afterCommit();
  const r = schema.receivedEmails;
  const releasedBy = encodeInboxActor(p.actor);
  const outcome = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [row] = await tx
      .select(RECEIVED_EMAIL_META_COLUMNS)
      .from(r)
      .where(and(eq(r.id, p.receivedEmailId), eq(r.teamId, p.teamId)))
      .for("update");
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const attachments = deps.keyring ? await openReceivedAttachments(row, deps.keyring) : [];
    if (p.inboxId === null) {
      if (!row.catchAll || row.virusVerdict !== "fail") {
        return { ok: false as const, reason: "not_found" as const };
      }
      if (row.releasedAt) return { ok: false as const, reason: "not_quarantined" as const };
      const [released] = await tx
        .update(r)
        .set({ releasedAt: now, releasedBy })
        .where(eq(r.id, row.id))
        .returning(RECEIVED_EMAIL_META_COLUMNS);
      if (!released) throw new Error("received_emails update returned no row");
      await announceIfVisible(tx, { row: released, attachments, now, after });
      return { ok: true as const, releasedAt: now, trustedSender: null };
    }
    const m = schema.receivedEmailInboxes;
    const [membership] = await tx
      .select({ verdict: m.verdict, threadId: m.threadId })
      .from(m)
      .where(and(eq(m.receivedEmailId, row.id), eq(m.inboxId, p.inboxId), eq(m.teamId, p.teamId)))
      .for("update");
    if (!membership) return { ok: false as const, reason: "not_found" as const };
    if (membership.verdict !== "quarantined") {
      return { ok: false as const, reason: "not_quarantined" as const };
    }
    const i = schema.inboxes;
    const [inbox] = await tx
      .select({ safety: i.safety })
      .from(i)
      .where(eq(i.id, p.inboxId))
      .for("update");
    if (!inbox) return { ok: false as const, reason: "not_found" as const };
    let trustedSender: string | null = null;
    const sender = row.from.toLowerCase();
    if (p.trustSender && sender) {
      if (!inbox.safety.allowlist.includes(sender)) {
        if (inbox.safety.allowlist.length >= INBOX_ALLOWLIST_MAX) {
          return { ok: false as const, reason: "allowlist_full" as const };
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
      set: { verdict: "released", releasedAt: now, releasedBy },
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
    return { ok: true as const, releasedAt: now, trustedSender };
  });
  if (!outcome.ok) return outcome;
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
