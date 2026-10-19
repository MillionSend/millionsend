import {
  type AbuseJudge,
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
  openReceivedAttachments,
  type QuarantineReason,
  runAfterCommit,
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
  now?: (() => Date) | undefined;
  /** Waits between throttled calls; tests skip the wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

/** A judged message this suspicious is delivered marked, not held. */
const SUSPICIOUS_SCORE = 50;

/**
 * The received.screen job: the inbound judge for one membership held
 * pending. Over a cap the mail is quarantined screening_cap; a judge that
 * fails (after a few throttle retries) leaves it quarantined unscreened:
 * agent inboxes fail closed, and a person can release either. The verdict
 * moves this message only: no monitor sample, no team risk.
 */
export async function screenReceived(
  db: Db,
  deps: ScreenDeps,
  job: { receivedEmailId: string; inboxId: string },
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const m = schema.receivedEmailInboxes;
  const [membership] = await db
    .select()
    .from(m)
    .where(and(eq(m.receivedEmailId, job.receivedEmailId), eq(m.inboxId, job.inboxId)));
  if (membership?.verdict !== "pending") return;
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
      await markDelivered(tx, {
        row,
        key,
        from: "pending",
        set: { ...set, verdict },
        spam,
        forwardTo: inbox.safety.forward_to,
        attachments,
        now,
        after,
      });
      await announceIfVisible(tx, { row, attachments, now, after });
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
  if (!deps.judge?.screen) {
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
    { row, tier: membership.senderTrust, inboxId: job.inboxId, now },
  );
  if (!verdict) {
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
    return finish();
  }
  const set = {
    reasons: verdict.reasons,
    injectionScore: verdict.injectionScore,
    phishingScore: verdict.phishingScore,
    judge: record,
  };
  const held = heldReason(verdict);
  if (held) {
    await quarantine(held, set);
  } else {
    const suspicious =
      Math.max(verdict.injectionScore, verdict.phishingScore) >= SUSPICIOUS_SCORE ||
      verdict.reasons.includes("concealed") ||
      rules.verdict === "suspicious";
    const spam = verdict.spamScore >= INBOUND_QUARANTINE_SCORE || rules.action === "spam";
    await deliver(suspicious ? "suspicious" : "clean", spam, set);
  }
  return finish();
}
