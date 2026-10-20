import { sharedInboxDomain } from "@millionsend/config";
import {
  type AbuseJudge,
  accountMailPhrase,
  applyJudgedSample,
  buildJudgeBlock,
  claimNotification,
  clearDestinations,
  decryptEmailBody,
  destinationVerdictParks,
  type EmailAttachment,
  isHoldVerdict,
  isPlatformLinkVerdict,
  isSharedInboxSender,
  type JudgeBlockInput,
  type JudgeVerdict,
  judgeErrorClass,
  type Keyring,
  type MediaIssue,
  type MonitorSettings,
  type MonitorTier,
  mediaParks,
  opaqueFacts,
  openAttachments,
  parseSingleSender,
  revokeDestinations,
  SCREEN_JUDGE_TIMEOUT_MS,
  screeningTier,
  sendingDomainYoung,
  spareWaitingSamples,
  teamDestinationStanding,
  teamMonitorOverview,
  teamMonitorRow,
  UNNAMED_ATTACHMENT,
  utcDay,
  type VerdictOutcome,
  verdictClearsDestinations,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type EmailSendPriority, emailSendPriority } from "@millionsend/queue";
import { and, eq } from "drizzle-orm";
import {
  type MediaRead,
  type MediaReadDeps,
  readMediaForJudge,
  saveMediaReview,
} from "../media/read.js";
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
  /** Hands a team the hold just suspended to the tenant.status job, which disables its SES tenant. */
  syncTenant?: ((teamId: string) => Promise<void>) | undefined;
  /** Queues again what waited on a screening verdict: an unsent email, or a new team's fan-out. */
  enqueueSend?: ((emailId: string, priority: EmailSendPriority) => Promise<void>) | undefined;
  enqueueBroadcast?: ((broadcastId: string) => Promise<void>) | undefined;
  /** The platform's own link domains (unsubscribe, tracking): never a customer's destination. */
  platformDomains?: ReadonlySet<string> | undefined;
  /**
   * Whether any of these new destinations is a link domain registered under
   * 7 days ago, by the shared cache and a bounded lookup, null while an age
   * is not known (see core anyYoungLinkDomain); absent, none is.
   */
  linkDomainYoung?: ((domains: readonly string[], at: Date) => Promise<boolean | null>) | undefined;
  /**
   * How images and files are read for the judge: the image reader (null
   * while ABUSE_VISION is off) and, in tests, the parsing threads and cache.
   * Absent, files are read and images are not.
   */
  media?: MediaReadDeps | undefined;
  /** SHARED_INBOX_DOMAIN, whose mail holds as a young domain's does; the environment's when absent. */
  sharedInboxDomain?: string | null | undefined;
}

/** A throttled call is retried this many times through the queue's backoff before the sample gives up. */
export const JUDGE_THROTTLE_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

export type JudgeOutcome = "judged" | "unjudged" | "skipped";

const ms = schema.monitorSamples;

/** Failures a second screening call may not meet: a slow or stumbling provider. */
const SCREEN_RETRYABLE = new Set(["timeout", "upstream"]);
/** Images our side could not read: a new team's young domain waits on them as on a judge outage. */
const MEDIA_UNREAD: ReadonlySet<MediaIssue> = new Set(["images_not_read", "vision_unavailable"]);

/**
 * Judge one pending sample. The block is built in memory from the stored
 * body and discarded with the call; the row keeps the verdict fields only.
 * A judge failure of any class records the sample unjudged and changes
 * nothing else; only a throttle is retried, and only a few times. Database
 * and decrypt errors throw so pg-boss retries the job. Mail waiting on a
 * screening sample is queued again once it has its answer, either way.
 */
export async function judgeSample(
  db: Db,
  deps: JudgeDeps,
  payload: { sampleId: string },
): Promise<JudgeOutcome> {
  const now = deps.now?.() ?? new Date();
  const [sample] = await db.select().from(ms).where(eq(ms.id, payload.sampleId));
  if (sample?.status !== "pending") return "skipped";
  const outcome = await judgePending(db, deps, sample, now);
  if (sample.screening && outcome !== "skipped") await resumeScreened(db, deps, sample);
  return outcome;
}

async function judgePending(
  db: Db,
  deps: JudgeDeps,
  sample: typeof schema.monitorSamples.$inferSelect,
  now: Date,
): Promise<JudgeOutcome> {
  const unjudged = async (errorClass: string, latencyMs?: number, mediaIssues?: MediaIssue[]) => {
    await db
      .update(ms)
      .set({
        status: "unjudged",
        errorClass,
        model: deps.judge?.model ?? null,
        latencyMs: latencyMs ?? null,
        judgedAt: now,
        mediaIssues: mediaIssues ?? null,
      })
      .where(and(eq(ms.id, sample.id), eq(ms.status, "pending")));
    console.warn(`abuse.judge: sample ${sample.id} unjudged (${errorClass})`);
    return "unjudged" as const;
  };
  if (!deps.judge) return unjudged("off");

  const loaded = await loadBlockInput(db, deps.keyring, sample, now);
  if (!loaded) return unjudged("body_purged");
  const settings = await deps.settings();
  const tier = await screeningTier(db, settings, sample.teamId, now);
  const media = await readMedia(loaded.input, loaded.files, tier, deps.media);
  const issues = media?.issues ?? [];
  const standing = await teamDestinationStanding(db, {
    teamId: sample.teamId,
    html: loaded.input.html,
    text: loaded.input.text,
    replyTo: loaded.input.replyTo,
    links: media?.findings.links.map((link) => link.url),
    ignore: deps.platformDomains,
    now,
  });
  const destinations = standing.novel;
  const vouchedNames = new Set(standing.vouched);
  const shared = isSharedInboxSender(
    loaded.input.from,
    deps.sharedInboxDomain === undefined ? sharedInboxDomain() : deps.sharedInboxDomain,
  );
  const youngSendingDomain =
    (await sendingDomainYoung(
      db,
      { teamId: sample.teamId, ...loaded.sendingDomain, shared },
      now,
    )) === true;
  if (issues.includes("vision_blocked")) await notifyMediaBlocked(db, deps, sample.teamId, now);
  // Mail this verdict holds back keeps what screening read, for the person who decides on it.
  const waiting = sample.screening && loaded.waiting;
  let kept = false;
  const keepMedia = async () => {
    if (kept || !media || !loaded.email) return;
    kept = true;
    try {
      await saveMediaReview(db, deps.keyring, loaded.email, await media.review());
    } catch (err) {
      console.error(`abuse.judge: media review for sample ${sample.id} not saved`, err);
    }
  };
  const mediaParked = waiting && mediaParks(issues, tier);
  if (mediaParked || loaded.email?.parkReason === "media") await keepMedia();
  if (
    waiting &&
    !mediaParked &&
    tier === "new" &&
    youngSendingDomain &&
    issues.some((issue) => MEDIA_UNREAD.has(issue))
  ) {
    return unjudged("media_unavailable", undefined, issues);
  }
  // Links to destinations the team never cleared lead the judge's link table.
  const block = buildJudgeBlock({
    ...loaded.input,
    novelDomains: new Set(destinations),
    media: media?.findings,
  });
  const timeoutMs = sample.screening
    ? SCREEN_JUDGE_TIMEOUT_MS
    : (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const judge = deps.judge;
  const call = () => judge.judge(block, { signal: AbortSignal.timeout(timeoutMs) });
  const started = Date.now();
  let verdict: Awaited<ReturnType<AbuseJudge["judge"]>>;
  try {
    verdict = await call().catch((err: unknown) => {
      if (!sample.screening || !SCREEN_RETRYABLE.has(judgeErrorClass(err))) throw err;
      return call();
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
    return unjudged(errorClass, latencyMs, issues);
  }
  const latencyMs = Date.now() - started;
  const model = verdict.model ?? judge.model;
  // Only a destination that drew a phishing-type verdict is dated.
  const linkYoung =
    destinations.length > 0 && isHoldVerdict(verdict, settings.holdRepeatScore)
      ? deps.linkDomainYoung
        ? await deps.linkDomainYoung(destinations, now)
        : false
      : null;
  // A product's own page on a platform, read as a lure: the team is spared the hold, and the mail
  // parks unless an operator cleared every such name. Judged after the send with no such clearance,
  // nothing is left to park, so the hold stands.
  const platformShape = sample.broadcastId === null && isPlatformLinkVerdict(verdict, standing.all);
  const vouched = platformShape && standing.all.every((d) => vouchedNames.has(d));
  const platformLink = platformShape && (sample.screening || vouched);
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
        destinations,
        linkYoung,
        mediaIssues: issues,
        judgedAt: now,
      })
      .where(and(eq(ms.id, sample.id), eq(ms.status, "pending")))
      .returning({ id: ms.id });
    // A concurrent run already wrote this sample: its verdict stands, the risk moved once.
    if (!judged) return null;
    const applied = await applyJudgedSample(t, settings, {
      teamId: sample.teamId,
      score: verdict.score,
      verdict,
      kind: sample.kind,
      broadcast: sample.broadcastId !== null,
      youngSendingDomain,
      youngLinkDomain: linkYoung === true,
      platformLink,
      now,
    });
    if (vouched) {
      await t.update(ms).set({ sparedHold: "vouched" }).where(eq(ms.id, sample.id));
    } else if (applied.spared) {
      // The park rests on every platform name the mail links to; releasing it clears them all.
      await t
        .update(ms)
        .set({ sparedHold: applied.spared.rule, destinations: standing.all })
        .where(eq(ms.id, sample.id));
      await spareWaitingSamples(t, {
        teamId: sample.teamId,
        holdRepeatScore: settings.holdRepeatScore,
      });
    }
    return applied;
  });
  if (!outcome) return "skipped";
  if (verdictClearsDestinations(verdict, destinations.length)) {
    await clearDestinations(db, sample.teamId, destinations, now);
  }
  // Mail to a destination that cleared within its probation, read as
  // phishing: the clearance goes, and the operator hears of it.
  const platformProbation =
    sample.broadcastId === null &&
    isPlatformLinkVerdict(verdict, standing.probation) &&
    standing.probation.every((d) => vouchedNames.has(d));
  if (
    standing.probation.length > 0 &&
    !platformProbation &&
    isHoldVerdict(verdict, settings.holdRepeatScore)
  ) {
    const revoked = await revokeDestinations(db, sample.teamId, standing.probation, now);
    if (revoked.length > 0) {
      await notifyDestination(
        db,
        deps,
        "monitor.destination_revoked",
        sample.teamId,
        verdict,
        revoked,
        now,
      );
    }
  }
  const spareParks = sample.screening && outcome.spared !== null && !vouched;
  const destinationParks =
    outcome.tier !== "exempt" &&
    (spareParks ||
      (sample.screening &&
        destinations.length > 0 &&
        outcome.tier !== "new" &&
        destinationVerdictParks({ ...verdict, linkYoung }, settings)));
  if (destinationParks) {
    await notifyDestination(
      db,
      deps,
      "monitor.destination_parked",
      sample.teamId,
      verdict,
      destinations.length > 0 ? destinations : standing.all,
      now,
    );
  }
  if (waiting && (destinationParks || outcome.held)) await keepMedia();
  if ((outcome.alert || outcome.paused || outcome.held) && deps.mailer) {
    await notifyOperator(db, deps, sample.teamId, verdict, outcome, settings, now);
  }
  if (outcome.held && deps.syncTenant) {
    // The hold already refuses every send; the tenant is a second lock, so a
    // failed hand-off is logged rather than failing a committed verdict.
    try {
      await deps.syncTenant(sample.teamId);
    } catch (err) {
      console.error(`abuse.judge: SES tenant hand-off for held team ${sample.teamId} failed`, err);
    }
  }
  return "judged";
}

/**
 * What the judge reads of a message's media: its files always, its body's
 * images while the team is new or the body is opaque. Null when there is
 * nothing to read.
 */
async function readMedia(
  input: JudgeBlockInput,
  files: EmailAttachment[],
  tier: MonitorTier,
  deps: MediaReadDeps | undefined,
): Promise<MediaRead | null> {
  const facts = opaqueFacts({ html: input.html, text: input.text, attachments: files.length });
  const readBodyImages = tier === "new" || facts.opaque;
  if (files.length === 0 && (!readBodyImages || facts.imageRefs.length === 0)) return null;
  return readMediaForJudge(
    { attachments: files, bodyImages: facts.imageRefs.map((ref) => ref.src), readBodyImages },
    deps ?? { vision: null },
  );
}

/**
 * What waited on a screening verdict goes back to its queue: the email's
 * send, which now reads the verdict and the hold or pause it brought, or the
 * new team's fan-out. A sent or settled email is left alone.
 */
async function resumeScreened(
  db: Db,
  deps: JudgeDeps,
  sample: typeof schema.monitorSamples.$inferSelect,
): Promise<void> {
  if (sample.kind === "broadcast_skeleton") {
    if (sample.broadcastId) await deps.enqueueBroadcast?.(sample.broadcastId);
    return;
  }
  if (!sample.emailId) return;
  const [email] = await db
    .select({
      latestStatus: schema.emails.latestStatus,
      sentAt: schema.emails.sentAt,
      broadcastId: schema.emails.broadcastId,
    })
    .from(schema.emails)
    .where(eq(schema.emails.id, sample.emailId));
  if (email?.latestStatus !== "queued" || email.sentAt) return;
  await deps.enqueueSend?.(sample.emailId, emailSendPriority(email));
}

/**
 * The operator hears once a day per team, per kind, that mail to a new
 * destination was parked, or that a cleared destination drew a
 * phishing-type verdict and is new again; the review list holds every
 * parked email.
 */
async function notifyDestination(
  db: Db,
  deps: JudgeDeps,
  kind: "monitor.destination_parked" | "monitor.destination_revoked",
  teamId: string,
  verdict: Pick<JudgeVerdict, "score" | "categories" | "reasons">,
  destinations: readonly string[],
  now: Date,
): Promise<void> {
  if (!deps.mailer) return;
  try {
    const claimed = await claimNotification(db, { teamId, kind, periodKey: utcDay(now) });
    if (!claimed) return;
    const [team] = await db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    await mailOperator(
      db,
      deps.mailer,
      kind,
      "/console/safety",
      {
        team: team?.name ?? teamId,
        score: String(verdict.score),
        verdict: [...verdict.categories, ...verdict.reasons].join(", "),
        domain: destinations.slice(0, 5).join(", "),
      },
      deps.appBaseUrl,
    );
  } catch (err) {
    console.error(`abuse.judge: destination mail for team ${teamId} failed`, err);
  }
}

/**
 * The judge's input for a sample: the email's decrypted body and opened
 * files, or the broadcast's own HTML for a skeleton; with the sending
 * domain, whose age the hold reads, and the email itself: whether it still
 * waits on this verdict, and why it is parked if it is.
 */
async function loadBlockInput(
  db: Db,
  keyring: Keyring,
  sample: typeof schema.monitorSamples.$inferSelect,
  now: Date,
): Promise<{
  input: JudgeBlockInput;
  sendingDomain: { domainId?: string | null; name?: string | null };
  files: EmailAttachment[];
  waiting: boolean;
  email: { id: string; teamId: string; parkReason: string | null } | null;
} | null> {
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
  // Screened ahead of its first send, a team is a day-0 team, not one of
  // unknown age: the thresholds were set on verdicts read that way.
  const context: JudgeBlockInput["team"] = {
    name: team.name,
    verifiedDomains: domains.map((d) => d.name),
    ageDays: monitor.firstSendAt
      ? Math.floor((now.getTime() - monitor.firstSendAt.getTime()) / DAY_MS)
      : 0,
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
    const replyTo = broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null;
    return {
      input: {
        team: context,
        from: broadcast.from,
        replyTo,
        subject: broadcast.subject,
        html: broadcast.html,
        text: broadcast.text,
        attachments: [],
      },
      sendingDomain: { name: parseSingleSender(broadcast.from)?.domain ?? null },
      files: [],
      waiting: true,
      email: null,
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
  const files = email.attachments ? await openAttachments(email.attachments, keyring, owner) : [];
  return {
    input: {
      team: context,
      from: email.from,
      replyTo: email.replyTo,
      subject: email.subject,
      html: body.html,
      text: body.text,
      attachments: files.map((a) => ({
        filename: a.filename ?? UNNAMED_ATTACHMENT,
        contentType: a.contentType,
      })),
    },
    sendingDomain: { domainId: email.domainId },
    files,
    waiting: email.latestStatus === "queued" && !email.sentAt,
    email: { id: email.id, teamId: email.teamId, parkReason: email.parkReason },
  };
}

/**
 * The operator hears once a day per team that the image reader's provider
 * refused an email's images themselves, as Bedrock's CSAM check does;
 * unsent mail of it waits on the review list.
 */
async function notifyMediaBlocked(db: Db, deps: JudgeDeps, teamId: string, now: Date) {
  if (!deps.mailer) return;
  try {
    const claimed = await claimNotification(db, {
      teamId,
      kind: "monitor.media_blocked",
      periodKey: utcDay(now),
    });
    if (!claimed) return;
    const [team] = await db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    await mailOperator(
      db,
      deps.mailer,
      "monitor.media_blocked",
      "/console/safety",
      { team: team?.name ?? teamId },
      deps.appBaseUrl,
    );
  } catch (err) {
    console.error(`abuse.judge: blocked-images mail for team ${teamId} failed`, err);
  }
}

async function notifyOperator(
  db: Db,
  deps: JudgeDeps,
  teamId: string,
  verdict: Pick<JudgeVerdict, "score" | "categories" | "reasons">,
  outcome: VerdictOutcome,
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
  const score = String(verdict.score);
  try {
    const held = outcome.held;
    if (held) {
      await mailOperator(
        db,
        deps.mailer,
        "monitor.team_held",
        path,
        (locale) => ({
          team: name,
          score,
          verdict: [...verdict.categories, ...verdict.reasons].join(", "),
          rule: accountMailPhrase({
            locale,
            kind: "monitor.team_held",
            key: held.rule,
            values:
              held.rule === "score"
                ? { line: String(settings.holdScore) }
                : held.rule === "repeat"
                  ? { line: String(settings.holdRepeatScore), n: String(held.verdicts) }
                  : { line: String(settings.holdRepeatScore) },
          }),
        }),
        deps.appBaseUrl,
      );
    }
    if (outcome.paused) {
      await mailOperator(
        db,
        deps.mailer,
        "monitor.broadcasts_paused",
        path,
        { team: name, risk, score },
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
        (locale) => ({
          team: name,
          risk,
          tier: accountMailPhrase({ locale, kind: "monitor.alert", key: outcome.tier }),
          samples: String(overview.judged7d),
          flagged: String(overview.flagged7d),
        }),
        deps.appBaseUrl,
      );
    }
  } catch (err) {
    console.error(`abuse.judge: operator mail for team ${teamId} failed`, err);
  }
}
