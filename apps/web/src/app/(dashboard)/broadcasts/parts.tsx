"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { PreviewSchemePills } from "@/components/preview-scheme-pills";
import type { TONE_COLOR } from "@/components/status-tile";
import { emulateEmailScheme } from "@/lib/email-preview";
import {
  formatDayTime,
  formatFinishAbout,
  formatStepDay,
  formatStepTime,
  formatUtcTimestamp,
  groupReleasesByDay,
  roundUpToQuarterHour,
  sameLocalDay,
  sendingDays,
} from "@/lib/format";
import { escapeHtml } from "@/lib/html";
import { MERGE_TOKEN_RE } from "@/lib/merge-fields";
import { usePreviewScheme } from "@/lib/use-preview-scheme";

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
 * live state. A `hold` replaces the sending pill with the still reason
 * ("Waiting for the plan · resumes …"), drawn as a warning.
 */
export function StatusPill({
  status,
  hold,
}: {
  status: BroadcastStatus;
  hold?: string | undefined;
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
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "currentColor",
            animation: "ms-pulse 2s infinite",
            flex: "none",
          }}
        />
      ) : null}
      {t(`status.${status}`)}
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
  planLabel: string | null;
  planPeriod: "day" | "month" | null;
  rung: { label: string; overage: boolean; finishesAt: Date | null } | null;
  horizonDays: number;
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
 * caller disables the primary on `estimate.blocked`.
 */
export function SendPlanSummary({
  count,
  estimate,
  cloud,
  locale,
  now = new Date(),
}: {
  count: number;
  estimate: SendPlanEstimate | null;
  cloud: boolean;
  locale: string;
  now?: Date;
}) {
  const t = useTranslations("broadcasts");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const finish = estimate?.finishesAt ? roundUpToQuarterHour(estimate.finishesAt) : null;
  const time = (d: Date) => formatStepTime(d, locale);
  const paced = estimate !== null && !estimate.blocked && estimate.first < count;
  let steps: Step[] = [];
  if (paced && estimate.startsAt && finish) {
    if (estimate.first === 0 && estimate.planHold === null) {
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
      const held = estimate.planHold !== null;
      // A daily cap releases at UTC midnight: one row per reset, not per local day.
      const days = groupReleasesByDay(
        estimate.releases,
        held && estimate.planPeriod === "day" ? "utc" : "local",
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
          const sub =
            held && estimate.planLabel
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
  return (
    <>
      <p style={{ margin: `0 0 ${steps.length > 0 ? 14 : 18}px`, fontSize: "var(--ms-fs-ui)" }}>
        {count === 0 ? t("guard.zero") : t("guard.body", { count: nf.format(count) })}
      </p>
      {steps.length > 0 ? (
        <ol className="ms-steps" aria-label={t("guard.title")}>
          {steps.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, position is identity
            <li key={i} className={step.now ? "now" : undefined}>
              <span className="when">{step.when}</span>
              <span className="what">
                {step.what}
                {step.sub ? <small>{step.sub}</small> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {paced && (planLine || estimate.planHold === null) ? (
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {planLine ? (
            <>
              {planLine} · <Link href="/settings/billing">{t("guard.seePlans")}</Link>
            </>
          ) : (
            t("guard.reason")
          )}
        </p>
      ) : null}
      {estimate?.blocked ? (
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
 */
export function PacingSteps({
  sent,
  releases,
  locale,
  compact = false,
  now = new Date(),
}: {
  sent: readonly { at: Date; count: number }[];
  releases: readonly { at: Date; endsAt: Date; count: number }[];
  locale: string;
  compact?: boolean;
  now?: Date;
}) {
  const t = useTranslations("broadcasts");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const days = sendingDays(sent, releases, now);
  if (days.length < 2) return null;
  const time = (d: Date) => formatStepTime(d, locale);
  return (
    <ol className={compact ? "ms-steps compact" : "ms-steps"} aria-label={t("detail.pacing")}>
      {days.map((day, i) => {
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
            : t("guard.stepLast", { count: n, time: finish });
        } else {
          what = compact
            ? t("detail.pacingMoreShort", { count: n })
            : t("guard.stepMore", { count: n });
          sub = t("detail.pacingFrom", { time: time(day.startsAt) });
        }
        return (
          <li key={day.startsAt.getTime()} className={day.state === "next" ? undefined : day.state}>
            <span className="when">
              {day.state === "now"
                ? t("detail.pacingTodayLabel")
                : formatStepDay(day.startsAt, locale)}
            </span>
            <span className="what">
              {what}
              {!compact && day.state === "now" ? (
                <span className="bar" aria-hidden="true">
                  <b
                    style={{
                      width: `${Math.min(100, (day.sent / Math.max(1, day.count)) * 100)}%`,
                    }}
                  />
                </span>
              ) : null}
              {!compact && sub ? <small>{sub}</small> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
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

/** The detail page's status cell: the pill (or the plan hold), and how far the send is. */
export function SendingStatus({
  status,
  progress,
  planHold,
  locale,
}: {
  status: BroadcastStatus;
  progress: SendingProgress | null;
  planHold: Date | null;
  locale: string;
}) {
  const t = useTranslations("broadcasts");
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const hold =
    status === "sending" && planHold
      ? t("detail.planHold", { date: formatStepDay(planHold, locale) })
      : undefined;
  const line = status === "sending" && progress ? progressLine(progress, t, nf) : null;
  return (
    <>
      <div style={{ marginTop: 6 }}>
        <StatusPill status={status} hold={hold} />
      </div>
      {line ? (
        <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 6 }}>{line}</div>
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
      <div style={{ fontSize: 13, marginTop: 7 }}>
        <span title={formatUtcTimestamp(about)}>{formatFinishAbout(about, locale)}</span>
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
          background: scheme === "dark" ? "#111113" : "#ffffff",
        }}
      />
    </div>
  );
}
