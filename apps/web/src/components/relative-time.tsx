"use client";

import { useLocale } from "next-intl";
import { formatRelative } from "@/lib/format";

export function RelativeTime({ date }: { date: Date | string | number }) {
  const locale = useLocale();
  const d = new Date(date);
  const iso = d.toISOString();
  return (
    // suppressHydrationWarning: server and client render moments differ
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      {formatRelative(d, locale)}
    </time>
  );
}
