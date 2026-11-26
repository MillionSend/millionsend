import {
  type AbuseJudge,
  abuseRules,
  afterCommit,
  announceIfVisible,
  decideScreening,
  heldReason,
  INBOUND_QUARANTINE_SCORE,
  judgeReceived,
  type Keyring,
  type MonitorSettings,
  markDelivered,
  markQuarantined,
  markUnscreenedHeld,
  nextJudgeRetry,
  openReceivedAttachments,
  type QuarantineReason,
  runAfterCommit,
  TRANSIENT_JUDGE_ERRORS,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { JUDGE_THROTTLE_RETRIES } from "./abuse-judge.js";

type ScreenDeps = {
  judge: AbuseJudge | null;
  keyring: Keyring;
  settings: MonitorSettings;
  timeoutMs: number;
  enqueueWebhookDeliveries: WebhookEnqueue;
  enqueueInboxForward: (p: { receivedEmailId: string; inboxId: string }) => Promise<void>;
  /** Queues a later screening of mail a transient judge failure left unscreened. */
  enqueueRetry: (
    p: { receivedEmailId: string; inboxId: string; retry: number },
    at: Date,
  ) => Promise<void>;
  now?: (() => Date) | undefined;
  /** Waits between throttled calls; tests skip the wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

/**
 * The received.screen job: the inbound judge for one membership held
 * pending. Over a cap the mail is quarantined screening_cap; a judge that
 * fails (after a few throttle retries) leaves it quarantined unscreened:
 * agent inboxes fail closed, and a person can release either. A failure
 * that may clear (timeout, upstream, throttled) is screened again on
 * JUDGE_RETRY_DELAYS_MS while the hold stands: a clean verdict delivers it,
 * a holding one swaps the reason. The verdict moves this message only: no
 * monitor sample, no team risk.
 */
export async function screenReceived(
  db: Db,
  deps: ScreenDeps,
  job: { receivedEmailId: string; inboxId: string; retry?: number | undefined },
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const m = schema.receivedEmailInboxes;
  const [membership] = await db
    .select()
    .from(m)
    .where(and(eq(m.receivedEmailId, job.receivedEmailId), eq(m.inboxId, job.inboxId)));
  if (!membership) return;
  // Any job on such a hold screens it again, so a first job rerun after its
  // retry failed to enqueue still starts the chain.
  const retrying =
    membership.verdict === "quarantined" &&
    membership.quarantineReason === "unscreened" &&
    membership.deliveredAt === null &&
    TRANSIENT_JUDGE_ERRORS.has(membership.judge?.status ?? "");
  if (membership.verdict !== "pending" && !retrying) return;
  const r = schema.receivedEmails;
  const [row] = await db.select().from(r).where(eq(r.id, job.receivedEmailId));
  const i = schema.inboxes;
  const [inbox] = await db
    .select({ kind: i.kind, safety: i.safety })
    .from(i)
    .where(eq(i.id, job.inboxId));
  if (!row || !inbox) return;
  const key = { receivedEmailId: row.id, inboxId: job.inboxId };
  const after = afterCommit();
  const attachments = await openReceivedAttachments(row, deps.keyring);
  const quarantine = async (
    reason: QuarantineReason,
    set: Parameters<typeof markQuarantined>[1]["set"],
  ) =>
    db.transaction(async (raw) => {
      await markQuarantined(raw as unknown as Db, { row, key, reason, set, now, after });
    });
  const deliver = async (
    verdict: "clean" | "suspicious",
    spam: boolean,
    set: Parameters<typeof markDelivered>[1]["set"],
  ) =>
    db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const delivered = await markDelivered(tx, {
        row,
        key,
        from: retrying ? "quarantined" : "pending",
        fromReason: retrying ? "unscreened" : undefined,
        set: { ...set, verdict },
        spam,
        forwardTo: inbox.safety.forward_to,
        attachments,
        now,
        after,
      });
      if (delivered || !retrying) await announceIfVisible(tx, { row, attachments, now, after });
    });
  const finish = () =>
    runAfterCommit(
      {
        enqueueWebhookDeliveries: deps.enqueueWebhookDeliveries,
        enqueueInboxForward: deps.enqueueInboxForward,
      },
      after,
    );

  // The inbox's rules without a judge: what happens when none answers, and
  // what a judged message still owes them (spam, a doubtful sender).
  const rules = decideScreening({
    kind: inbox.kind,
    safety: inbox.safety,
    tier: membership.senderTrust,
    spam: row.spamVerdict,
    virus: row.virusVerdict,
    judgeAvailable: false,
    forwardedContent: false,
  });
  const scheduleRetry = async (status: string) => {
    const next = nextJudgeRetry(status, job.retry, now);
    if (next) await deps.enqueueRetry({ ...key, retry: next.retry }, next.at);
  };
  if (!deps.judge?.screen) {
    if (retrying) return;
    // No judge to ask (ABUSE_JUDGE off, or a judge without the inbound set).
    if (rules.action === "quarantine") await quarantine(rules.reason ?? "unscreened", undefined);
    else
      await deliver(
        rules.verdict === "suspicious" ? "suspicious" : "clean",
        rules.action === "spam",
        {},
      );
    return finish();
  }

  const { verdict, record } = await judgeReceived(
    db,
    {
      judge: deps.judge,
      keyring: deps.keyring,
      settings: deps.settings,
      timeoutMs: deps.timeoutMs,
      retries: JUDGE_THROTTLE_RETRIES,
      sleep: deps.sleep,
    },
    { row, tier: membership.senderTrust, inboxId: job.inboxId, now, retry: retrying },
  );
  if (!verdict) {
    if (retrying) {
      await db
        .update(m)
        .set({ judge: record })
        .where(
          and(
            eq(m.receivedEmailId, key.receivedEmailId),
            eq(m.inboxId, key.inboxId),
            eq(m.verdict, "quarantined"),
            eq(m.quarantineReason, "unscreened"),
          ),
        );
      await scheduleRetry(record.status);
      return;
    }
    if (record.status === "screening_cap") {
      await quarantine("screening_cap", { judge: record });
      return finish();
    }
    if (record.status !== "body_purged") {
      console.warn(
        `received.screen: membership ${job.receivedEmailId}/${job.inboxId} unscreened (${record.status})`,
      );
    }
    await quarantine("unscreened", { judge: record });
    await finish();
    await scheduleRetry(record.status);
    return;
  }
  const set = {
    reasons: verdict.reasons,
    injectionScore: verdict.injectionScore,
    phishingScore: verdict.phishingScore,
    judge: record,
  };
  const held = heldReason(verdict);
  if (held && retrying) {
    await markUnscreenedHeld(db, { row, key, reason: held, set });
  } else if (held) {
    await quarantine(held, set);
  } else {
    const suspicious =
      // A judged message this suspicious is delivered marked, not held.
      Math.max(verdict.injectionScore, verdict.phishingScore) >=
        abuseRules().limits.inbound.suspiciousScore ||
      verdict.reasons.includes("concealed") ||
      rules.verdict === "suspicious";
    const spam = verdict.spamScore >= INBOUND_QUARANTINE_SCORE || rules.action === "spam";
    await deliver(suspicious ? "suspicious" : "clean", spam, set);
  }
  return finish();
}
