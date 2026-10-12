import {
  type AbuseJudge,
  afterCommit,
  announceIfVisible,
  buildInboundJudgeBlock,
  decideScreening,
  INBOUND_JUDGE_PER_INBOX_DAILY,
  INBOUND_JUDGE_QUESTIONS_VERSION,
  INBOUND_QUARANTINE_SCORE,
  type InboundJudgeVerdict,
  judgeErrorClass,
  type Keyring,
  type MonitorSettings,
  markDelivered,
  markQuarantined,
  openReceivedAttachments,
  openReceivedRaw,
  parseReceivedMetadata,
  type QuarantineReason,
  resultRows,
  runAfterCommit,
  utcDay,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
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

/** The first wait after a throttle; each retry doubles it. */
const THROTTLE_BACKOFF_MS = 1_000;
/** A judged message this suspicious is delivered marked, not held. */
const SUSPICIOUS_SCORE = 50;

/**
 * Spends one judged message of the team's day, the instance's day and the
 * inbox's day, all or nothing. The instance cap is soft (concurrent jobs can
 * pass it by a few), as the outbound monitor's is. Inbound counters are
 * their own: a flood of mail to a team never spends its outbound sampling.
 */
async function spendJudgeCaps(
  db: Db,
  p: { teamId: string; inboxId: string; settings: MonitorSettings; now: Date },
): Promise<boolean> {
  const day = utcDay(p.now);
  const c = schema.usageCounters;
  const [total] = resultRows<{ n: number | null }>(
    await db.execute(
      sql`select sum(${c.inboundJudged})::int as n from ${c} where ${c.day} = ${day}`,
    ),
  );
  if ((total?.n ?? 0) >= p.settings.instanceDailyCap) return false;
  try {
    return await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const team = await tx.execute(sql`
        insert into ${c} (team_id, day, inbound_judged) values (${p.teamId}, ${day}, 1)
        on conflict (team_id, day) do update set inbound_judged = ${c.inboundJudged} + 1
          where ${c.inboundJudged} < ${p.settings.teamDailyCap}
        returning inbound_judged`);
      const u = schema.inboxUsageDaily;
      const inbox = await tx.execute(sql`
        insert into ${u} (inbox_id, day, judged) values (${p.inboxId}, ${day}, 1)
        on conflict (inbox_id, day) do update set judged = ${u.judged} + 1
          where ${u.judged} < ${INBOUND_JUDGE_PER_INBOX_DAILY}
        returning judged`);
      if (resultRows(team).length === 0 || resultRows(inbox).length === 0) throw new CapsSpent();
      return true;
    });
  } catch (err) {
    if (err instanceof CapsSpent) return false;
    throw err;
  }
}

class CapsSpent extends Error {}

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
    .select({ kind: i.kind, safety: i.safety, teamId: i.teamId, teamName: schema.teams.name })
    .from(i)
    .innerJoin(schema.teams, eq(schema.teams.id, i.teamId))
    .where(eq(i.id, job.inboxId));
  if (!row || !inbox) return;
  const key = { receivedEmailId: row.id, inboxId: job.inboxId };
  const after = afterCommit();
  const judgeRecord = (status: string, latencyMs: number, model?: string) => ({
    version: INBOUND_JUDGE_QUESTIONS_VERSION,
    model: model ?? deps.judge?.model ?? "none",
    status,
    latency_ms: latencyMs,
  });
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
  const screen = deps.judge?.screen?.bind(deps.judge);
  if (!screen) {
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

  if (
    !(await spendJudgeCaps(db, {
      teamId: inbox.teamId,
      inboxId: job.inboxId,
      settings: deps.settings,
      now,
    }))
  ) {
    await quarantine("screening_cap", { judge: judgeRecord("screening_cap", 0) });
    return finish();
  }
  const rawMessage = await openReceivedRaw(row, deps.keyring);
  if (!rawMessage) {
    await quarantine("unscreened", { judge: judgeRecord("body_purged", 0) });
    return finish();
  }
  const parsed = await parseReceivedMetadata(rawMessage);
  const owned = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, inbox.teamId), eq(schema.domains.status, "verified")));
  const block = buildInboundJudgeBlock({
    teamName: inbox.teamName,
    ownerDomains: owned.map((d) => d.name),
    fromName: row.fromName,
    from: row.from,
    tier: membership.senderTrust,
    authentication: row.authentication,
    replyTo: row.replyTo,
    subject: row.subject,
    html: parsed.html,
    text: parsed.text,
    attachments: parsed.attachments,
    automated: row.automated,
  });
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let verdict: InboundJudgeVerdict | null = null;
  let failure: string | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      verdict = await screen(block, { signal: AbortSignal.timeout(deps.timeoutMs) });
      break;
    } catch (err) {
      const errorClass = judgeErrorClass(err);
      if (errorClass === "throttled" && attempt < JUDGE_THROTTLE_RETRIES) {
        await sleep(THROTTLE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      failure = errorClass;
      break;
    }
  }
  const latencyMs = Date.now() - started;
  if (!verdict) {
    console.warn(
      `received.screen: membership ${job.receivedEmailId}/${job.inboxId} unscreened (${failure})`,
    );
    await quarantine("unscreened", { judge: judgeRecord(failure ?? "upstream", latencyMs) });
    return finish();
  }
  const set = {
    reasons: verdict.reasons,
    injectionScore: verdict.injectionScore,
    phishingScore: verdict.phishingScore,
    judge: judgeRecord("judged", latencyMs, verdict.model),
  };
  if (verdict.injectionScore >= INBOUND_QUARANTINE_SCORE) {
    await quarantine("injection", set);
  } else if (verdict.phishingScore >= INBOUND_QUARANTINE_SCORE) {
    await quarantine("phishing", set);
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
