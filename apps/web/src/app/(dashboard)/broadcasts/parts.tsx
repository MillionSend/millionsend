"use client";

import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { DotParts } from "@/components/dot-parts";
import { NoticeStrip } from "@/components/notice-strip";
import { PreviewSchemePills } from "@/components/preview-scheme-pills";
import { Select } from "@/components/select";
import type { TONE_COLOR } from "@/components/status-tile";
import { type RailStep, StepRail } from "@/components/step-rail";
import { emulateEmailScheme, PREVIEW_CANVAS } from "@/lib/email-preview";
import {
  formatDay,
  formatDayTime,
  formatFinishAbout,
  formatStepDay,
  formatStepTime,
  formatUtcTimestamp,
  groupReleasesByDay,
  roundUpToQuarterHour,
  sameLocalDay,
  sameUtcDay,
  sendingDays,
} from "@/lib/format";
import { escapeHtml } from "@/lib/html";
import { MERGE_TOKEN_RE } from "@/lib/merge-fields";
import { usePreviewScheme } from "@/lib/use-preview-scheme";
import { utcDayInstant, warmupPlanSteps } from "@/lib/warmup";
import type { AppRouter } from "@/server/routers";

// Stand-in values so every merge pill reads as real content in the preview
// rather than a raw {{{TOKEN}}}. UNSUBSCRIBE_URL becomes a dead "#" — the
// worker resolves the real link at send time. Unknown names fall back to the
// author's own |fallback, then to the bare name.
const PREVIEW_SAMPLES: Record<string, string> = {
  FIRST_NAME: "Ada",
  LAST_NAME: "Lovelace",
  EMAIL: "ada@example.com",
  UNSUBSCRIBE_URL: "#",
};

/** Fill every merge token with a preview sample; `samples` supplies real
 * per-contact-property values where the caller has them. Values are
 * HTML-escaped — contact-controlled property strings must read as text in the
 * preview, never as markup. */
export function fillMergeSamples(html: string, samples: Record<string, string>): string {
  return html.replace(MERGE_TOKEN_RE, (_m, name: string, fallback: string | undefined) =>
    escapeHtml(PREVIEW_SAMPLES[name] ?? samples[name] ?? fallback ?? name),
  );
}

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled";

/** What "Send test" got back: sent, held (naming only the new domain limit), or refused. */
export type TestSendResult =
  | { kind: "sent"; to: string }
  | { kind: "queued"; domain: string | null }
  | { kind: "rateLimited" }
  | { kind: "failed" };

/** The note under the composer's "Send test" button. */
export function TestSendNote({ result }: { result: TestSendResult }) {
  const t = useTranslations("broadcasts");
  const refused = result.kind === "rateLimited" || result.kind === "failed";
  return (
    <span
      className="ms-action-note"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        color: refused ? "var(--ms-danger)" : "var(--ms-muted)",
        fontSize: "var(--ms-fs-label)",
        // The held note is a sentence or two: it wraps under the button.
        ...(result.kind === "queued"
          ? { width: 320, whiteSpace: "normal", textAlign: "right" }
          : { whiteSpace: "nowrap" }),
      }}
    >
      {result.kind === "sent"
        ? `✓ ${t("composer.testSent", { email: result.to })}`
        : result.kind === "queued"
          ? result.domain
            ? t("composer.testQueuedLimit", { domain: result.domain })
            : t("composer.testQueued")
          : t(result.kind === "rateLimited" ? "composer.testRateLimited" : "composer.testFailed")}
    </span>
  );
}

// Pill variant per the canvas: draft and canceled stay neutral, scheduled
// warns (it will cost sends), sending informs, sent reads as done.
export const PILL_VARIANT: Record<BroadcastStatus, keyof typeof TONE_COLOR> = {
  draft: "neutral",
  scheduled: "warn",
  sending: "info",
  sent: "success",
  canceled: "neutral",
};

/**
 * Broadcast status pill; "sending" carries a pulsing dot — it is the only
 * live state. A `hold` replaces the pill with the still reason ("Waiting for
 * the plan · resumes …", "Delayed"), drawn as a warning; a `label` renames
 * the state ("Warming up").
 */
export function StatusPill({
  status,
  hold,
  label,
}: {
  status: BroadcastStatus;
  hold?: string | undefined;
  label?: string | undefined;
}) {
  const t = useTranslations("broadcasts");
  if (hold) return <span className="ms-badge ms-badge-warn">{hold}</span>;
  return (
    <span
      className={`ms-badge ms-badge-${PILL_VARIANT[status]}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      {status === "sending" ? (
        <span
          aria-hidden="true"
          className="ms-dot xs"
          style={{ background: "currentColor", animation: "ms-pulse 2s infinite" }}
        />
      ) : null}
      {label ?? t(`status.${status}`)}
    </span>
  );
}

/** The planner's answer for a send being initiated, as the router returns it. */
export interface SendPlanEstimate {
  first: number;
  startsAt: Date | null;
  finishesAt: Date | null;
  days: number;
  blocked: boolean;
  releases: { at: Date; endsAt: Date; count: number }[];
  planHold: { heldBack: number; resumesAt: Date } | null;
  /** The sender domain's new domain limit, when it holds rows back. */
  newDomainHold?: { heldBack: number; resumesAt: Date; domain: string; cap: number } | null;
  planLabel: string | null;
  planPeriod: "day" | "month" | null;
  rung: { label: string; overage: boolean; finishesAt: Date | null } | null;
  horizonDays: number;
}

/** What the sender domain's warm-up does to the send, as the router returns it. */
export type SendPlanWarmup = NonNullable<
  inferRouterOutputs<AppRouter>["broadcasts"]["sendPlan"]["warmup"]
>;

/** The send dialog's choice while a warm-up is offered. */
export type SendPace = "warmup" | "normal";

/** Whether the send goes out by the domain's warm-up: always while it is on, by choice while offered. */
export function sendsByWarmup(warmup: SendPlanWarmup | null, pace: SendPace): boolean {
  return (
    warmup !== null &&
    (warmup.status === "warming" || warmup.status === "paused" || pace === "warmup")
  );
}

interface Step {
  when: string;
  what: string;
  sub?: string | undefined;
  now?: boolean;
}

/** A release starting this close to now reads as "Now". */
const NOW_WINDOW_MS = 60_000;

/**
 * The send dialog's plan: the intro count, one timeline row per sending day
 * when the send is paced, and the reason (or the plan that would not hold
 * it back). Renders the too-large error in place of the timeline; the
 * caller disables the primary on `estimate.blocked`. With a `warmup`, the
 * domain's warm-up: its plan while it is on, or, for a risky send, the
 * choice between warming up and the normal pace.
 */
export function SendPlanSummary({
  count,
  estimate,
  cloud,
  locale,
  now = new Date(),
  warmup = null,
  pace = "warmup",
  onPace,
  onSkipInactive,
  scheduled = false,
}: {
  count: number;
  estimate: SendPlanEstimate | null;
  cloud: boolean;
  locale: string;
  now?: Date;
  warmup?: SendPlanWarmup | null;
  pace?: SendPace;
  onPace?: (pace: SendPace) => void;
  onSkipInactive?: (skip: boolean) => void;
  /** Starts later than now, so the warm-up's first day reads as a date. */
  scheduled?: boolean;
}) {
  const t = useTranslations("broadcasts");
  const tWarmup = useTranslations("warmup");
  const tGuard = useTranslations("deliverability");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const finish = estimate?.finishesAt ? roundUpToQuarterHour(estimate.finishesAt) : null;
  const time = (d: Date) => formatStepTime(d, locale);
  const paced = estimate !== null && !estimate.blocked && estimate.first < count;
  // The new domain limit paces the send when the plan does not: no plan lifts it.
  const limitHold = estimate?.planHold ? null : (estimate?.newDomainHold ?? null);
  let steps: Step[] = [];
  if (paced && estimate.startsAt && finish) {
    const held = estimate.planHold !== null || limitHold !== null;
    if (estimate.first === 0 && !held) {
      // The day sits in the rail column, the clock times in the text: a
      // full stamp would wrap the narrow column.
      const starts = roundUpToQuarterHour(estimate.startsAt);
      steps = [
        {
          when: formatStepDay(starts, locale),
          what: t("guard.stepStarts", { time: time(starts) }),
        },
        {
          when: formatStepDay(finish, locale),
          what: t("guard.stepAllSent", { count: nf.format(count), time: time(finish) }),
        },
      ];
    } else {
      // A daily cap releases at UTC midnight: one row per reset, not per local day.
      const days = groupReleasesByDay(
        estimate.releases,
        limitHold || (held && estimate.planPeriod === "day") ? "utc" : "local",
      );
      steps = days.map((day, i) => {
        const last = i === days.length - 1;
        const n = nf.format(day.count);
        const isNow = i === 0 && day.startsAt.getTime() - now.getTime() < NOW_WINDOW_MS;
        const when = isNow ? t("guard.stepNow") : formatStepDay(day.startsAt, locale);
        if (days.length === 1) {
          return { when, what: t("guard.stepOnly", { count: n, time: time(finish) }), now: isNow };
        }
        if (i === 0) {
          const sub = limitHold
            ? t("guard.stepLimitDomain", { domain: limitHold.domain })
            : held && estimate.planLabel
              ? t(estimate.planPeriod === "month" ? "guard.stepLimitMonth" : "guard.stepLimitDay", {
                  plan: estimate.planLabel,
                })
              : undefined;
          return {
            when,
            what:
              held && estimate.first === 0
                ? t("guard.stepFirstReset", { count: n, reset: time(day.startsAt) })
                : t("guard.stepFirst", { count: n }),
            sub,
            now: isNow,
          };
        }
        if (last) {
          return {
            when,
            what: held
              ? t("guard.stepLastReset", {
                  count: n,
                  reset: time(day.startsAt),
                  time: time(finish),
                })
              : t("guard.stepLast", { count: n, time: time(finish) }),
          };
        }
        return {
          when,
          what: held
            ? t("guard.stepMoreReset", { count: n, reset: time(day.startsAt) })
            : t("guard.stepMore", { count: n }),
        };
      });
    }
  }
  const rungFinish = estimate?.rung?.finishesAt
    ? roundUpToQuarterHour(estimate.rung.finishesAt)
    : null;
  const planLine =
    estimate?.rung && rungFinish
      ? t(estimate.rung.overage ? "guard.planFitsOverage" : "guard.planFits", {
          plan: estimate.rung.label,
          time: sameLocalDay(rungFinish, now)
            ? t("guard.todayAt", { time: time(rungFinish) })
            : formatFinishAbout(rungFinish, locale),
        })
      : null;
  const byWarmup = sendsByWarmup(warmup, pace);
  const offered = warmup !== null && warmup.status !== "warming" && warmup.status !== "paused";
  const warmFinish = warmup?.plan.finishesAt ? roundUpToQuarterHour(warmup.plan.finishesAt) : null;
  // Paused, the send waits with nothing to plan; on, the warm-up's own days.
  const ramp = byWarmup && warmup?.status !== "paused" ? warmup : null;
  const rampDays = ramp?.plan.perDay.filter((d) => d.count > 0) ?? [];
  const pacedRail = !byWarmup && steps.length > 0;
  // The offered warm-up's first day: today, or the day a scheduled send starts.
  const firstDay = warmup?.plan.perDay[0];
  const firstDayValues = {
    start: nf.format(firstDay?.count ?? 0),
    when: firstDay && !sameUtcDay(utcDayInstant(firstDay.day), now) ? "later" : "today",
    day: firstDay ? formatStepDay(utcDayInstant(firstDay.day), locale) : "",
  };
  return (
    <>
      <p
        style={{
          margin: `0 0 ${pacedRail || warmup ? 14 : 18}px`,
          fontSize: "var(--ms-fs-ui)",
        }}
      >
        {count === 0 ? t("guard.zero") : t("guard.body", { count: nf.format(count) })}
      </p>
      {warmup && offered ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <NoticeStrip
              tone="warn"
              text={
                warmup.bestDay > 0
                  ? t("guard.riskNotice", {
                      domain: warmup.domain,
                      best: warmup.bestDay,
                      count: nf.format(warmup.eligible),
                    })
                  : t("guard.riskNoticeNew", {
                      domain: warmup.domain,
                      count: nf.format(warmup.eligible),
                    })
              }
            />
          </div>
          <div style={{ display: "grid", gap: 6, marginBottom: 16 }}>
            <label className="ms-radio-card">
              <input
                type="radio"
                name="send-pace"
                checked={pace === "warmup"}
                onChange={() => onPace?.("warmup")}
              />
              <span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    color: "var(--ms-bone)",
                  }}
                >
                  {tWarmup("off.switch")}
                  <span className="ms-chip" style={{ fontSize: 10.5, padding: "1px 7px" }}>
                    {t("guard.recommended")}
                  </span>
                </span>
                <div className="sub">
                  {warmFinish
                    ? t("guard.optionWarmupSub", {
                        ...firstDayValues,
                        date: formatStepDay(warmFinish, locale),
                      })
                    : t("guard.optionWarmupSubOpen", firstDayValues)}
                </div>
              </span>
            </label>
            <label className="ms-radio-card">
              <input
                type="radio"
                name="send-pace"
                checked={pace === "normal"}
                onChange={() => onPace?.("normal")}
              />
              <span>
                <span style={{ color: "var(--ms-bone)" }}>{t("guard.optionNormal")}</span>
                <div className="sub">
                  {finish && !estimate?.blocked
                    ? t("guard.optionNormalSub", { date: formatStepDay(finish, locale) })
                    : t("guard.optionNormalSubOpen")}
                </div>
              </span>
            </label>
          </div>
        </>
      ) : warmup ? (
        <p style={{ margin: "0 0 14px", fontSize: "var(--ms-fs-ui)" }}>
          {t(warmup.status === "paused" ? "guard.pausedIntro" : "guard.warmingIntro", {
            domain: warmup.domain,
          })}
        </p>
      ) : null}
      {ramp && rampDays.length > 0 ? (
        <StepRail
          label={t("guard.warmupPlan")}
          steps={warmupPlanSteps({
            perDay: rampDays,
            locale,
            t: tWarmup,
            labels: "dates",
            startsNow:
              !scheduled &&
              rampDays[0] !== undefined &&
              sameUtcDay(utcDayInstant(rampDays[0].day), now),
            last: (n) =>
              warmFinish
                ? t(rampDays.length === 1 ? "guard.stepOnly" : "guard.stepLast", {
                    count: n,
                    time: time(warmFinish),
                  })
                : tWarmup("rail.more", { count: n }),
          })}
        />
      ) : null}
      {pacedRail ? (
        <StepRail
          label={t("guard.title")}
          steps={steps.map((step) => ({
            when: step.when,
            what: step.what,
            sub: step.sub,
            state: step.now ? "now" : undefined,
          }))}
        />
      ) : null}
      {ramp && ramp.inactive > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            margin: "6px 0 14px",
            padding: "10px 0",
            borderTop: "1px solid var(--ms-line)",
            borderBottom: "1px solid var(--ms-line)",
          }}
        >
          <span style={{ fontSize: 13, color: "var(--ms-bone)" }}>
            {t("guard.inactiveLabel")}
            <span style={{ display: "block", fontSize: 12, color: "var(--ms-muted)" }}>
              {t("guard.inactiveSub", { date: formatDay(ramp.inactiveSince, locale) })}
            </span>
          </span>
          <Select
            value={ramp.skipInactive ? "skip" : "last"}
            onChange={(value) => onSkipInactive?.(value === "skip")}
            ariaLabel={t("guard.inactiveLabel")}
            width={220}
            options={[
              {
                value: "skip",
                label: t("guard.inactiveSkip", { count: nf.format(ramp.inactive) }),
              },
              { value: "last", label: tWarmup("settings.inactiveLast") },
            ]}
          />
        </div>
      ) : null}
      {ramp ? (
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("guard.warmupReason")}
        </p>
      ) : !byWarmup && paced && (planLine || estimate.planHold === null) ? (
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {planLine ? (
            <>
              {planLine} · <Link href="/settings/billing">{t("guard.seePlans")}</Link>
            </>
          ) : limitHold ? (
            t("guard.limitReason", { domain: limitHold.domain, cap: nf.format(limitHold.cap) })
          ) : (
            t("guard.reason")
          )}
        </p>
      ) : null}
      {byWarmup ? (
        warmup?.blocked ? (
          <p className="ms-field-error" style={{ margin: "0 0 18px" }}>
            {tGuard("sendGuard.warmupTooLong", { days: warmup.horizonDays })}
          </p>
        ) : null
      ) : estimate?.blocked ? (
        <p className="ms-field-error" style={{ margin: "0 0 18px" }}>
          {t(cloud ? "guard.tooLarge" : "guard.tooLargeSelfHost", { days: estimate.horizonDays })}
        </p>
      ) : null}
    </>
  );
}

/** The list's and the detail's rows for a broadcast still going out. */
export interface SendingProgress {
  sentCount: number | null;
  parkedCount: number | null;
  /** The whole audience: the walk's own count until it has written every row. */
  recipients: number;
  finishesAt: Date | null;
}

/**
 * A sending broadcast's days on the send dialog's step rail: days already
 * out, today with its progress, the days still ahead. `compact` is the
 * list tooltip's cut: counts only. Nothing for a send that fits in one day.
 * `resets` when the new domain limit paces it: one row per 00:00 UTC
 * reset, each worded as the reset it waits for.
 */
export function PacingSteps({
  sent,
  releases,
  locale,
  compact = false,
  now = new Date(),
  resets = false,
}: {
  sent: readonly { at: Date; count: number }[];
  releases: readonly { at: Date; endsAt: Date; count: number }[];
  locale: string;
  compact?: boolean;
  now?: Date;
  resets?: boolean;
}) {
  const t = useTranslations("broadcasts");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const days = sendingDays(sent, releases, now, resets ? "utc" : "local");
  if (days.length < 2) return null;
  const time = (d: Date) => formatStepTime(d, locale);
  const steps = days.map((day, i): RailStep => {
    const n = nf.format(day.count);
    const last = i === days.length - 1;
    const finish = time(roundUpToQuarterHour(day.endsAt));
    let what: string;
    let sub: string | undefined;
    if (day.state === "done") {
      what = t("detail.pacingDone", { count: n });
      sub = t("detail.pacingRange", { start: time(day.startsAt), end: time(day.endsAt) });
    } else if (day.state === "now") {
      what = compact
        ? t("detail.pacingTodayShort", { sent: nf.format(day.sent), count: n })
        : t("detail.pacingToday", { sent: nf.format(day.sent), count: n });
      sub = t(last ? "detail.pacingTodayLast" : "detail.pacingTodayRange", {
        start: time(day.startsAt),
        end: finish,
      });
    } else if (last) {
      what = compact
        ? t("detail.pacingLastShort", { count: n })
        : resets
          ? t("guard.stepLastReset", { count: n, reset: time(day.startsAt), time: finish })
          : t("guard.stepLast", { count: n, time: finish });
    } else if (resets && !compact) {
      what = t("guard.stepMoreReset", { count: n, reset: time(day.startsAt) });
    } else {
      what = compact
        ? t("detail.pacingMoreShort", { count: n })
        : t("guard.stepMore", { count: n });
      sub = t("detail.pacingFrom", { time: time(day.startsAt) });
    }
    return {
      key: day.startsAt.getTime(),
      when:
        day.state === "now" ? t("detail.pacingTodayLabel") : formatStepDay(day.startsAt, locale),
      what,
      sub,
      state: day.state === "next" ? undefined : day.state,
      progress: day.state === "now" ? day.sent / Math.max(1, day.count) : undefined,
    };
  });
  return <StepRail label={t("detail.pacing")} steps={steps} compact={compact} />;
}

/** "70,000 sent · 99,700 waiting": every row not yet out counts as waiting. */
export function progressLine(
  progress: SendingProgress,
  t: (key: string, values: Record<string, string>) => string,
  nf: Intl.NumberFormat,
): string | null {
  if (progress.sentCount === null) return null;
  return t("detail.progress", {
    sent: nf.format(progress.sentCount),
    waiting: nf.format(Math.max(0, progress.recipients - progress.sentCount)),
  });
}

/** The detail page's status cell: the pill (or the hold), and how far the send is. */
export function SendingStatus({
  status,
  progress,
  planHold,
  held,
  warmup = null,
  locale,
}: {
  status: BroadcastStatus;
  progress: SendingProgress | null;
  planHold: Date | null;
  held: boolean;
  /** Its domain's warm-up, while it still holds rows of this send. */
  warmup?: "warming" | "paused" | null;
  locale: string;
}) {
  const t = useTranslations("broadcasts");
  const tWarmup = useTranslations("warmup");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const hold = held
    ? t("held.label")
    : status === "sending" && planHold
      ? t("detail.planHold", { date: formatStepDay(planHold, locale) })
      : warmup === "paused"
        ? tWarmup("status.paused")
        : undefined;
  const line = held
    ? t("held.body")
    : status === "sending" && progress
      ? progressLine(progress, t, nf)
      : null;
  return (
    <>
      <div style={{ marginTop: 6 }}>
        <StatusPill
          status={status}
          hold={hold}
          label={warmup === "warming" ? tWarmup("status.warming") : undefined}
        />
      </div>
      {line ? (
        <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 6 }}>
          <DotParts text={line} />
        </div>
      ) : null}
    </>
  );
}

/** The detail page's "Finishes about" cell while a send is going out. */
export function FinishCell({
  finishesAt,
  startedAt,
  locale,
}: {
  finishesAt: Date;
  startedAt: Date | null;
  locale: string;
}) {
  const t = useTranslations("broadcasts");
  const about = roundUpToQuarterHour(finishesAt);
  return (
    <>
      {/* The day and the time each stay whole: a narrow column breaks between
          them, never inside the zone ("GMT-3"). */}
      <div style={{ fontSize: 13, marginTop: 7 }}>
        <span title={formatUtcTimestamp(about)}>
          <span className="ms-part">{formatStepDay(about, locale)},</span>{" "}
          <span className="ms-part">{formatStepTime(about, locale)}</span>
        </span>
      </div>
      {startedAt ? (
        <div style={{ fontSize: 12, color: "var(--ms-faint)", marginTop: 4 }}>
          {t("detail.started", { time: formatDayTime(startedAt, locale) })}
        </div>
      ) : null}
    </>
  );
}

/**
 * Sandboxed render of broadcast HTML; scripts never run. Every merge token is
 * shown as a sample value so the preview reads like a real send. The frame
 * runs edge to edge like the email detail's, with the same light/dark client
 * pills, following the dashboard's theme until the author picks one.
 */
export function ContentPreview({
  html,
  title,
  samples = {},
}: {
  html: string;
  title: string;
  samples?: Record<string, string>;
}) {
  const [scheme, setScheme] = usePreviewScheme();
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "8px 12px",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <PreviewSchemePills scheme={scheme} onChange={setScheme} />
      </div>
      <iframe
        title={title}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={emulateEmailScheme(fillMergeSamples(html, samples), scheme)}
        style={{
          display: "block",
          width: "100%",
          height: 560,
          border: 0,
          background: PREVIEW_CANVAS[scheme],
        }}
      />
    </div>
  );
}
