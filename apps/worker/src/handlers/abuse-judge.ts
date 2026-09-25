import {
  type AbuseJudge,
  applyJudgedSample,
  buildJudgeBlock,
  decryptEmailBody,
  type JudgeBlockInput,
  judgeErrorClass,
  type Keyring,
  type MonitorSettings,
  openAttachments,
  teamMonitorOverview,
  teamMonitorRow,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

export interface JudgeDeps {
  /** Null when the monitor is off: every sample is recorded unjudged. */
  judge: AbuseJudge | null;
  keyring: Keyring;
  settings: () => Promise<MonitorSettings>;
  timeoutMs?: number | undefined;
  mailer?: SystemMailer | undefined;
  appBaseUrl?: string | undefined;
  now?: (() => Date) | undefined;
}

/** A throttled call is retried this many times through the queue's backoff before the sample gives up. */
export const JUDGE_THROTTLE_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

export type JudgeOutcome = "judged" | "unjudged" | "skipped";

const ms = schema.monitorSamples;

/**
 * Judge one pending sample. The block is built in memory from the stored
 * body and discarded with the call; the row keeps the verdict fields only.
 * A judge failure of any class records the sample unjudged and changes
 * nothing else; only a throttle is retried, and only a few times. Database
 * and decrypt errors throw so pg-boss retries the job.
 */
export async function judgeSample(
  db: Db,
  deps: JudgeDeps,
  payload: { sampleId: string },
): Promise<JudgeOutcome> {
  const now = deps.now?.() ?? new Date();
  const [sample] = await db.select().from(ms).where(eq(ms.id, payload.sampleId));
  if (sample?.status !== "pending") return "skipped";
  const unjudged = async (errorClass: string, latencyMs?: number) => {
    await db
      .update(ms)
      .set({
        status: "unjudged",
        errorClass,
        model: deps.judge?.model ?? null,
        latencyMs: latencyMs ?? null,
        judgedAt: now,
      })
      .where(and(eq(ms.id, sample.id), eq(ms.status, "pending")));
    console.warn(`abuse.judge: sample ${sample.id} unjudged (${errorClass})`);
    return "unjudged" as const;
  };
  if (!deps.judge) return unjudged("off");

  const input = await loadBlockInput(db, deps.keyring, sample, now);
  if (!input) return unjudged("body_purged");
  const block = buildJudgeBlock(input);
  const started = Date.now();
  let verdict: Awaited<ReturnType<AbuseJudge["judge"]>>;
  try {
    verdict = await deps.judge.judge(block, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const errorClass = judgeErrorClass(err);
    const latencyMs = Date.now() - started;
    if (errorClass === "throttled" && sample.attempts < JUDGE_THROTTLE_RETRIES) {
      await db
        .update(ms)
        .set({ attempts: sample.attempts + 1 })
        .where(eq(ms.id, sample.id));
      throw err;
    }
    return unjudged(errorClass, latencyMs);
  }
  const latencyMs = Date.now() - started;
  const settings = await deps.settings();
  const model = verdict.model ?? deps.judge.model;
  // The verdict and its fold commit together: a crash between them would
  // leave a judged row the retry skips and a risk that never saw it.
  const outcome = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [judged] = await t
      .update(ms)
      .set({
        status: "judged",
        score: verdict.score,
        verdict: verdict.verdict,
        categories: verdict.categories,
        reasons: verdict.reasons,
        impersonatedBrand: verdict.impersonatedBrand,
        language: verdict.language,
        model,
        latencyMs,
        judgedAt: now,
      })
      .where(and(eq(ms.id, sample.id), eq(ms.status, "pending")))
      .returning({ id: ms.id });
    // A concurrent run already wrote this sample: its verdict stands, the risk moved once.
    if (!judged) return null;
    return applyJudgedSample(t, settings, { teamId: sample.teamId, score: verdict.score, now });
  });
  if (!outcome) return "skipped";
  if ((outcome.alert || outcome.paused) && deps.mailer) {
    await notifyOperator(db, deps, sample.teamId, verdict.score, outcome, settings, now);
  }
  return "judged";
}

/** The judge's input for a sample: the email's decrypted body, or the broadcast's own HTML for a skeleton. */
async function loadBlockInput(
  db: Db,
  keyring: Keyring,
  sample: typeof schema.monitorSamples.$inferSelect,
  now: Date,
): Promise<JudgeBlockInput | null> {
  const [team] = await db
    .select({ name: schema.teams.name, plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, sample.teamId));
  if (!team) return null;
  const domains = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, sample.teamId), eq(schema.domains.status, "verified")));
  const monitor = await teamMonitorRow(db, sample.teamId);
  const context: JudgeBlockInput["team"] = {
    name: team.name,
    verifiedDomains: domains.map((d) => d.name),
    ageDays: monitor.firstSendAt
      ? Math.floor((now.getTime() - monitor.firstSendAt.getTime()) / DAY_MS)
      : null,
    plan: team.plan as string,
  };
  if (sample.kind === "broadcast_skeleton") {
    if (!sample.broadcastId) return null;
    const [broadcast] = await db
      .select({
        from: schema.broadcasts.from,
        replyTo: schema.broadcasts.replyTo,
        subject: schema.broadcasts.subject,
        html: schema.broadcasts.html,
        text: schema.broadcasts.text,
      })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, sample.broadcastId));
    if (!broadcast) return null;
    return {
      team: context,
      from: broadcast.from,
      replyTo: broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null,
      subject: broadcast.subject,
      html: broadcast.html,
      text: broadcast.text,
      attachments: [],
    };
  }
  if (!sample.emailId) return null;
  const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, sample.emailId));
  if (
    !email ||
    email.bodyPurgedAt ||
    !email.bodyCiphertext ||
    !email.bodyIv ||
    !email.bodyWrappedDek ||
    email.bodyKeyVersion === null
  ) {
    return null;
  }
  const owner = { teamId: email.teamId, rowId: email.id };
  const body = await decryptEmailBody(
    {
      ciphertext: email.bodyCiphertext,
      iv: email.bodyIv,
      wrappedDek: email.bodyWrappedDek,
      keyVersion: email.bodyKeyVersion,
    },
    keyring,
    owner,
  );
  const attachments = email.attachments
    ? (await openAttachments(email.attachments, keyring, owner)).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
      }))
    : [];
  return {
    team: context,
    from: email.from,
    replyTo: email.replyTo,
    subject: email.subject,
    html: body.html,
    text: body.text,
    attachments,
  };
}

async function notifyOperator(
  db: Db,
  deps: JudgeDeps,
  teamId: string,
  score: number,
  outcome: { risk: number; tier: string; alert: boolean; paused: boolean },
  settings: MonitorSettings,
  now: Date,
): Promise<void> {
  if (!deps.mailer) return;
  const [team] = await db
    .select({ name: schema.teams.name })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const name = team?.name ?? teamId;
  const path = `/console/safety/${teamId}`;
  const risk = outcome.risk.toFixed(2);
  try {
    if (outcome.paused) {
      await mailOperator(
        db,
        deps.mailer,
        "monitor.broadcasts_paused",
        path,
        { team: name, risk, score: String(score) },
        deps.appBaseUrl,
      );
    }
    if (outcome.alert) {
      const overview = await teamMonitorOverview(db, teamId, settings, now);
      await mailOperator(
        db,
        deps.mailer,
        "monitor.alert",
        path,
        {
          team: name,
          risk,
          tier: outcome.tier,
          samples: String(overview.judged7d),
          flagged: String(overview.flagged7d),
        },
        deps.appBaseUrl,
      );
    }
  } catch (err) {
    console.error(`abuse.judge: operator mail for team ${teamId} failed`, err);
  }
}
