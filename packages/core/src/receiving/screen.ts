import type { AbuseJudgeConfig } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { InboxJudgeRecord } from "@millionsend/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { buildInboundJudgeBlock, INBOUND_JUDGE_QUESTIONS_VERSION } from "../abuse-judge/inbound.js";
import {
  type AbuseJudge,
  type InboundJudgeVerdict,
  judgeErrorClass,
} from "../abuse-judge/types.js";
import { createTypesafeJudge } from "../abuse-judge/typesafe.js";
import type { Keyring } from "../crypto/keyring.js";
import { resultRows } from "../driver-result.js";
import { INBOUND_JUDGE_PER_INBOX_DAILY, INBOUND_QUARANTINE_SCORE } from "../inboxes/limits.js";
import type { SenderTrust } from "../inboxes/types.js";
import type { MonitorSettings } from "../monitor-settings.js";
import { SCREEN_JUDGE_TIMEOUT_MS } from "../screening.js";
import { utcDay } from "../utc-day.js";
import { openReceivedRaw, parseReceivedMetadata, type ReceivedEmailRow } from "./message.js";

/** The first wait after a throttle; each retry doubles it. */
const THROTTLE_BACKOFF_MS = 1_000;

class CapsSpent extends Error {}

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

export interface InboundJudgeRun {
  /** Null when the judge was not asked, or could not answer. */
  verdict: InboundJudgeVerdict | null;
  /** The membership's judge record: its status is judged, or why not (screening_cap, body_purged, a judge error class). */
  record: InboxJudgeRecord;
}

/**
 * The inbound judge on one received message for one inbox: a judged message
 * of the day's caps spent first, then the message read into the judge's
 * block and the judge asked, a throttle retried `retries` times. The
 * received.screen job runs it on mail held pending, and a release on a hold
 * made before screening.
 */
export async function judgeReceived(
  db: Db,
  deps: {
    judge: AbuseJudge;
    keyring: Keyring;
    settings: MonitorSettings;
    timeoutMs: number;
    retries: number;
    /** Waits between throttled calls; tests skip the wait. */
    sleep?: ((ms: number) => Promise<void>) | undefined;
  },
  p: { row: ReceivedEmailRow; tier: SenderTrust; inboxId: string; now: Date },
): Promise<InboundJudgeRun> {
  const record = (status: string, latencyMs: number, model?: string): InboxJudgeRecord => ({
    version: INBOUND_JUDGE_QUESTIONS_VERSION,
    model: model ?? deps.judge.model,
    status,
    latency_ms: latencyMs,
  });
  const screen = deps.judge.screen?.bind(deps.judge);
  if (!screen) return { verdict: null, record: record("off", 0) };
  const teamId = p.row.teamId;
  if (
    !(await spendJudgeCaps(db, {
      teamId,
      inboxId: p.inboxId,
      settings: deps.settings,
      now: p.now,
    }))
  ) {
    return { verdict: null, record: record("screening_cap", 0) };
  }
  const raw = await openReceivedRaw(p.row, deps.keyring);
  if (!raw) return { verdict: null, record: record("body_purged", 0) };
  const parsed = await parseReceivedMetadata(raw);
  const [team] = await db
    .select({ name: schema.teams.name })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const owned = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.status, "verified")));
  const block = buildInboundJudgeBlock({
    teamName: team?.name ?? "",
    ownerDomains: owned.map((d) => d.name),
    fromName: p.row.fromName,
    from: p.row.from,
    tier: p.tier,
    authentication: p.row.authentication,
    replyTo: p.row.replyTo,
    subject: p.row.subject,
    html: parsed.html,
    text: parsed.text,
    attachments: parsed.attachments,
    automated: p.row.automated,
  });
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const verdict = await screen(block, { signal: AbortSignal.timeout(deps.timeoutMs) });
      return { verdict, record: record("judged", Date.now() - started, verdict.model) };
    } catch (err) {
      const errorClass = judgeErrorClass(err);
      if (errorClass === "throttled" && attempt < deps.retries) {
        await sleep(THROTTLE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      return { verdict: null, record: record(errorClass, Date.now() - started) };
    }
  }
}

/** What a verdict holds a message for: injection first, then phishing; null under the line. */
export function heldReason(
  v: Pick<InboundJudgeVerdict, "injectionScore" | "phishingScore">,
): "injection" | "phishing" | null {
  if (v.injectionScore >= INBOUND_QUARANTINE_SCORE) return "injection";
  if (v.phishingScore >= INBOUND_QUARANTINE_SCORE) return "phishing";
  return null;
}

/** The judge a release asks first, and how long a person waits on it. */
export interface ReleaseScreen {
  judge: AbuseJudge;
  timeoutMs: number;
  /** The process's settings reader; without one the row is read. */
  settings?: (() => Promise<MonitorSettings>) | undefined;
}

/** A release's judge from ABUSE_JUDGE's config; undefined while the content monitor is off. */
export function releaseScreen(
  config: AbuseJudgeConfig | null,
  settings?: (() => Promise<MonitorSettings>) | undefined,
): ReleaseScreen | undefined {
  if (!config) return undefined;
  return {
    judge: createTypesafeJudge(config),
    // A person waits on the answer: no longer than mail waits on a screening call.
    timeoutMs: Math.min(config.timeoutMs, SCREEN_JUDGE_TIMEOUT_MS),
    settings,
  };
}
