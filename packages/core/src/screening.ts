import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  inFirstWindow,
  isHoldVerdict,
  loadMonitorState,
  type MonitorDeps,
  monitorRowWithHistory,
  recordMonitorSample,
  YOUNG_DOMAIN_DAYS,
} from "./abuse-monitor.js";
import { countDistinctRecipients } from "./accept-email.js";
import type { MonitorSettings } from "./monitor-settings.js";
import { releaseQuota } from "./quota.js";
import { fetchTeamQuota } from "./team-plan.js";
import { DAY_MS } from "./utc-day.js";

/**
 * Screening before SES: which mail waits for the judge's verdict before it
 * is sent, and what it does while it waits. The send handler asks on every
 * pass; the judge re-queues the send once the verdict lands, and the hold,
 * the pause and the parks the verdict brings are read on the next pass.
 */

/** Why an email is judged before SES. */
export type ScreenReason = "first_window";

/**
 * A phishing-type verdict that held nothing waits this long before it is
 * sent: a burst reaches the repeat hold's count within it, so nothing of it
 * goes out.
 */
export const SCREEN_HOLD_WAIT_MS = 2 * 60_000;
/** While the judge fails on a young domain's mail it is re-run this often, this many times. */
export const SCREEN_RETRY_MS = 2 * 60_000;
export const SCREEN_RETRIES = 3;
/** Mail waits on a screening call: a short timeout, and one retry, beat the outage path. */
export const SCREEN_JUDGE_TIMEOUT_MS = 5_000;
/** A screening sample still pending after this lost its job; the next pass queues it again. */
const SCREEN_STALE_MS = 10 * 60_000;

/** Park reasons the drain never releases: only an operator does, from the review list. */
export const OPERATOR_PARK_REASONS = ["screening", "media"] as const;

const ms = schema.monitorSamples;
const e = schema.emails;

type Sample = typeof schema.monitorSamples.$inferSelect;

/**
 * Whether the team's sending domain reads as young at `at`: registered
 * under YOUNG_DOMAIN_DAYS before it, or of unknown age (no source had a
 * date, or the lookup has not answered yet). Null when the team has no
 * such domain row.
 */
export async function sendingDomainYoung(
  db: Db,
  input: { teamId: string; domainId?: string | null; name?: string | null },
  at: Date,
): Promise<boolean | null> {
  const d = schema.domains;
  const match = input.domainId
    ? eq(d.id, input.domainId)
    : input.name
      ? eq(d.name, input.name.toLowerCase())
      : null;
  if (!match) return null;
  const [row] = await db
    .select({ registeredAt: d.registeredAt })
    .from(d)
    .where(and(eq(d.teamId, input.teamId), match))
    .limit(1);
  if (!row) return null;
  return (
    row.registeredAt === null ||
    at.getTime() - row.registeredAt.getTime() < YOUNG_DOMAIN_DAYS * DAY_MS
  );
}

/**
 * Why this email is judged before SES; empty when it is not. Every reason
 * is decided here. A broadcast's copies are screened at its fan-out instead:
 * its own HTML, and its first rendered copy.
 */
export async function screeningReasons(
  db: Db,
  s: MonitorSettings,
  input: { email: { teamId: string; broadcastId: string | null }; now: Date },
): Promise<ScreenReason[]> {
  const reasons: ScreenReason[] = [];
  if (input.email.broadcastId === null) {
    const row = await monitorRowWithHistory(db, input.email.teamId, input.now);
    const state = await loadMonitorState(db, row, input.now);
    if (state.plan !== "system" && inFirstWindow(state, s, input.now)) reasons.push("first_window");
  }
  return reasons;
}

/**
 * A screening sample without a verdict: wait for it ("wait", the judge
 * re-queues what waits on it), re-run a failed judge for a young or
 * unknown-age sending domain, give up on it ("park") once the re-runs are
 * spent, or go on unscreened ("proceed") for an older domain. Null once the
 * sample is judged.
 */
async function unanswered(
  db: Db,
  deps: MonitorDeps,
  sample: Sample,
  input: { domainId: string | null; now: Date },
): Promise<"wait" | "park" | "proceed" | null> {
  const { now } = input;
  if (sample.status === "judged") return null;
  if (sample.status === "pending") {
    if (now.getTime() - sample.createdAt.getTime() > SCREEN_STALE_MS) {
      await deps.enqueueJudge(sample.id, { teamId: sample.teamId, screening: true });
    }
    return "wait";
  }
  const young = await sendingDomainYoung(
    db,
    { teamId: sample.teamId, domainId: input.domainId },
    now,
  );
  if (!young) return "proceed";
  if (sample.screenRetries >= SCREEN_RETRIES) return "park";
  const [rearmed] = await db
    .update(ms)
    .set({
      status: "pending",
      errorClass: null,
      judgedAt: null,
      latencyMs: null,
      attempts: 0,
      screenRetries: sample.screenRetries + 1,
    })
    .where(and(eq(ms.id, sample.id), eq(ms.status, "unjudged")))
    .returning({ id: ms.id });
  if (rearmed) {
    await deps.enqueueJudge(sample.id, {
      teamId: sample.teamId,
      screening: true,
      startAfter: new Date(now.getTime() + SCREEN_RETRY_MS),
    });
  }
  return "wait";
}

export type ScreenDecision =
  /**
   * Send now. `sample` is the email's screening sample when it has one: no
   * second sample is drawn after the send, and one the judge never answered
   * is judged then (`unjudged`), as unscreened mail is.
   */
  | { action: "send"; sample: { id: string; unjudged: boolean } | null }
  /** Wait: run the send again at `until`, or when the judge re-queues it (null). */
  | { action: "wait"; until: Date | null }
  /** The judge kept failing on a young domain's email: it waits for an operator. */
  | { action: "park" };

const SEND_UNSCREENED: ScreenDecision = { action: "send", sample: null };

/**
 * The gate in front of SES for one queued customer email, on when the
 * judge (`deps`) and the auto-hold are. An email with a screening reason
 * and no verdict waits for one; a phishing-type verdict that held nothing
 * waits SCREEN_HOLD_WAIT_MS more in the team's first window, in case the
 * burst it belongs to holds the team; a judge that keeps failing parks a
 * young domain's email and lets an older one's through. The team's own
 * standing (a hold, a pause) is the caller's to read first, on every pass.
 */
export async function screenBeforeSend(
  db: Db,
  deps: MonitorDeps,
  input: {
    email: {
      id: string;
      teamId: string;
      domainId: string | null;
      broadcastId: string | null;
      screenReleasedAt: Date | null;
    };
    now: Date;
  },
): Promise<ScreenDecision> {
  const { email, now } = input;
  // The settings reader throws only before its first read; the monitor's own
  // draw degrades to off the same way.
  const s = await deps.settings().catch(() => null);
  if (!s?.autoHold) return SEND_UNSCREENED;
  const [sample] = await db
    .select()
    .from(ms)
    .where(eq(ms.emailId, email.id))
    .orderBy(desc(ms.createdAt))
    .limit(1);
  const screened = sample?.screening ? { id: sample.id, unjudged: false } : null;
  if (email.screenReleasedAt) return { action: "send", sample: screened };
  if (!sample) {
    if ((await screeningReasons(db, s, { email, now })).length === 0) return SEND_UNSCREENED;
    const id = await recordMonitorSample(db, deps, s, {
      teamId: email.teamId,
      emailId: email.id,
      broadcastId: email.broadcastId,
      kind: "first_sends",
      now,
      screening: true,
    });
    // Past the team's daily cap the email goes unscreened, as the draw would.
    return id ? { action: "wait", until: null } : SEND_UNSCREENED;
  }
  if (!sample.screening) return SEND_UNSCREENED;
  const waiting = await unanswered(db, deps, sample, { domainId: email.domainId, now });
  if (waiting === "wait") return { action: "wait", until: null };
  if (waiting === "park") return { action: "park" };
  if (waiting === "proceed") return { action: "send", sample: { id: sample.id, unjudged: true } };
  if (
    sample.judgedAt &&
    isHoldVerdict(sample, s.holdRepeatScore) &&
    (await screeningReasons(db, s, { email, now })).includes("first_window")
  ) {
    const until = new Date(sample.judgedAt.getTime() + SCREEN_HOLD_WAIT_MS);
    if (now < until) return { action: "wait", until };
  }
  return { action: "send", sample: screened };
}

/**
 * Where a new team's fan-out stands on its broadcast's own HTML: "wait" for
 * the verdict (the judge re-queues the fan-out), "go", or "park" every copy
 * for an operator once the judge kept failing on a young sending domain. A
 * verdict that pauses or holds the team is read by the fan-out's own checks.
 */
export async function broadcastScreen(
  db: Db,
  deps: MonitorDeps,
  input: { skeletonSampleId: string; domainId: string; now: Date },
): Promise<"wait" | "go" | "park"> {
  const [sample] = await db.select().from(ms).where(eq(ms.id, input.skeletonSampleId));
  if (!sample?.screening) return "go";
  const waiting = await unanswered(db, deps, sample, input);
  return waiting === "wait" || waiting === "park" ? waiting : "go";
}

/** A screened email that went out without a verdict is judged afterwards, as unscreened mail is. */
export async function judgeAfterSend(
  db: Db,
  deps: MonitorDeps,
  sample: { id: string; teamId: string },
): Promise<void> {
  const [rearmed] = await db
    .update(ms)
    .set({ status: "pending", screening: false, errorClass: null, judgedAt: null, attempts: 0 })
    .where(and(eq(ms.id, sample.id), eq(ms.status, "unjudged")))
    .returning({ id: ms.id });
  if (rearmed) await deps.enqueueJudge(rearmed.id, { teamId: sample.teamId, screening: false });
}

/** Rows parked for an operator, or for a hold the operator decides on. */
const parkedForReview = (): SQL | undefined =>
  and(
    eq(e.latestStatus, "queued_quota"),
    isNull(e.sentAt),
    inArray(e.parkReason, ["review", ...OPERATOR_PARK_REASONS]),
  );

function scope(teamId: string, emailIds: readonly string[] | undefined): SQL | undefined {
  return and(eq(e.teamId, teamId), emailIds ? inArray(e.id, [...emailIds]) : undefined);
}

/**
 * Queued emails of the team waiting out the short wait a phishing-type
 * verdict from `holdLine` brings, not released from it yet.
 */
async function waitingOnVerdict(
  db: Db,
  input: { teamId: string; emailIds?: readonly string[] | undefined; holdLine: number },
): Promise<string[]> {
  const rows = await db
    .select({
      id: e.id,
      score: ms.score,
      verdict: ms.verdict,
      categories: ms.categories,
      reasons: ms.reasons,
    })
    .from(e)
    .innerJoin(ms, and(eq(ms.emailId, e.id), eq(ms.screening, true)))
    .where(
      and(
        scope(input.teamId, input.emailIds),
        eq(e.latestStatus, "queued"),
        isNull(e.sentAt),
        isNull(e.screenReleasedAt),
        eq(ms.status, "judged"),
      ),
    );
  return rows.filter((row) => isHoldVerdict(row, input.holdLine)).map((row) => row.id);
}

/**
 * The review list's Release: these emails of the team are sent without
 * being screened again. Parked rows lose their park reason, so quota.drain
 * releases them, charging the plan and the warm-up as for any parked row;
 * rows waiting out a verdict are returned for the caller to queue now. Mail
 * a review hold parks is released with the hold, never here.
 */
export async function releaseWaitingEmails(
  db: Db,
  input: {
    teamId: string;
    emailIds?: readonly string[] | undefined;
    holdLine: number;
    now?: Date;
  },
): Promise<{ parked: number; queued: string[] }> {
  const now = input.now ?? new Date();
  const parked = await db
    .update(e)
    .set({ parkReason: null, screenReleasedAt: now })
    .where(
      and(
        scope(input.teamId, input.emailIds),
        eq(e.latestStatus, "queued_quota"),
        isNull(e.sentAt),
        inArray(e.parkReason, [...OPERATOR_PARK_REASONS]),
      ),
    )
    .returning({ id: e.id });
  const waiting = await waitingOnVerdict(db, input);
  const queued =
    waiting.length === 0
      ? []
      : await db
          .update(e)
          .set({ screenReleasedAt: now })
          .where(and(inArray(e.id, waiting), eq(e.latestStatus, "queued"), isNull(e.sentAt)))
          .returning({ id: e.id });
  return { parked: parked.length, queued: queued.map((row) => row.id) };
}

/**
 * The review list's Cancel: these emails of the team never go out. A queued
 * row hands back the reservation it held; a parked one held none.
 */
export async function cancelWaitingEmails(
  db: Db,
  input: { teamId: string; emailIds?: readonly string[] | undefined; holdLine: number },
): Promise<number> {
  const waiting = await waitingOnVerdict(db, input);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows = await t
      .update(e)
      .set({ latestStatus: "canceled" })
      .where(
        or(
          and(scope(input.teamId, input.emailIds), parkedForReview()),
          waiting.length === 0
            ? undefined
            : and(inArray(e.id, waiting), eq(e.latestStatus, "queued"), isNull(e.sentAt)),
        ),
      )
      .returning({ to: e.to, cc: e.cc, bcc: e.bcc, parkReason: e.parkReason });
    const units = rows
      .filter((row) => row.parkReason === null)
      .reduce((n, row) => n + countDistinctRecipients(row.to, row.cc, row.bcc), 0);
    if (units > 0) {
      const quota = await fetchTeamQuota(t, input.teamId, true);
      if (quota) await releaseQuota(t, { teamId: input.teamId, count: units, quota });
    }
    return rows.length;
  });
}
