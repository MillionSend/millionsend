import type { WarmupOutcome } from "@millionsend/core";
import type React from "react";
import type { RailStep } from "@/components/step-rail";
import { formatStepDay, formatStepTime, roundUpToQuarterHour } from "@/lib/format";
import {
  type Translate,
  utcDayInstant,
  type WarmupSignalView,
  warmupReasonShort,
} from "@/lib/warmup";

/** A checked day's outcome as the suffix on its rail row; a day that grew or ran light reads as plain "sent". */
const OUTCOME_ROW: Partial<Record<WarmupOutcome, string>> = {
  held: "rail.held",
  stepped_back: "rail.steppedBack",
  paused: "rail.paused",
};

/**
 * Days already out, oldest first, from the "warmup" namespace: what each
 * sent with its check's outcome, why a day that missed missed, and the order
 * on the first.
 */
export function warmupSentSteps(
  days: readonly {
    day: string;
    count: number;
    outcome: WarmupOutcome | null;
    signals: readonly WarmupSignalView[] | null;
  }[],
  t: Translate,
  locale: string,
): RailStep[] {
  const nf = new Intl.NumberFormat(locale);
  return days.map((d, i) => {
    const reason = d.signals ? warmupReasonShort(d.signals, t, locale) : null;
    return {
      key: d.day,
      when: formatStepDay(utcDayInstant(d.day), locale),
      what: t((d.outcome && OUTCOME_ROW[d.outcome]) ?? "rail.sent", { count: nf.format(d.count) }),
      sub: reason ? (
        <span style={{ color: "var(--ms-warn)" }}>{reason}</span>
      ) : i === 0 ? (
        t("rail.firstNote")
      ) : undefined,
      state: "done",
    };
  });
}

/** Today's row: what goes out against what went, and the window it goes out in. */
export function warmupTodayStep(
  today: {
    allowance: number;
    sent: number;
    checked: boolean;
    window: { startsAt: Date; endsAt: Date } | null;
  },
  t: Translate,
  locale: string,
): RailStep {
  const nf = new Intl.NumberFormat(locale);
  return {
    key: "today",
    when: t("rail.todayLabel"),
    what: t("rail.today", { allowance: nf.format(today.allowance), sent: nf.format(today.sent) }),
    sub: !today.checked
      ? t("rail.todayWaiting")
      : today.window
        ? t("rail.todayWindow", {
            start: formatStepTime(today.window.startsAt, locale),
            end: formatStepTime(roundUpToQuarterHour(today.window.endsAt), locale),
          })
        : undefined,
    state: "now",
    progress: today.sent / Math.max(1, today.allowance),
  };
}

/** A send's days under a microlabel, with the note that explains its pace. */
export function PaceBand({
  label,
  note,
  style,
  children,
}: {
  label: string;
  note: React.ReactNode;
  style?: React.CSSProperties;
  /** The rail. */
  children: React.ReactNode;
}) {
  return (
    <div className="ms-pacing" style={style}>
      <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
        {label}
      </div>
      {children}
      <p>{note}</p>
    </div>
  );
}
