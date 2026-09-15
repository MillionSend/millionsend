"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";
import { formatDayUtc } from "@/lib/format";

/** The number formats the region screens share: plain digits, fixed-decimal percentages, hour and day labels. */
export function useRegionFormats() {
  const locale = useLocale();
  return useMemo(() => {
    const percent = (digits: number) =>
      new Intl.NumberFormat(locale, {
        style: "percent",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    const hour = new Intl.DateTimeFormat(locale, { hour: "numeric" });
    const nf = new Intl.NumberFormat(locale);
    const one = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    return {
      locale,
      n: (v: number) => nf.format(v),
      oneDecimal: (v: number) => one.format(v),
      pct0: (v: number) => percent(0).format(v),
      pct2: (v: number) => percent(2).format(v),
      pct3: (v: number) => percent(3).format(v),
      hourLabel: (iso: string) => hour.format(new Date(iso)),
      dayLabel: (day: string) => formatDayUtc(day, locale),
    };
  }, [locale]);
}
