"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";
import { formatDayUtc, roundUpToQuarterHour } from "@/lib/format";

/** The number formats the region screens share: plain digits, fixed-decimal percentages, limits, day labels. */
export function useRegionFormats() {
  const locale = useLocale();
  return useMemo(() => {
    const percent = (digits: number) =>
      new Intl.NumberFormat(locale, {
        style: "percent",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    const limit = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
    const clears = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const nf = new Intl.NumberFormat(locale);
    const one = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    return {
      locale,
      n: (v: number) => nf.format(v),
      oneDecimal: (v: number) => one.format(v),
      pct0: (v: number) => percent(0).format(v),
      pct2: (v: number) => percent(2).format(v),
      pct3: (v: number) => percent(3).format(v),
      /** A line as it is quoted, no trailing zeros: "4%", "0.4%". */
      pctLimit: (v: number) => limit.format(v),
      dayLabel: (day: string) => formatDayUtc(day, locale),
      /** "Fri 10:30": a forecast, rounded up to the quarter hour. */
      clearsAbout: (at: Date | string) => clears.format(roundUpToQuarterHour(at)),
    };
  }, [locale]);
}
