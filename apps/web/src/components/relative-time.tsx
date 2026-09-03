"use client";

import { useLocale } from "next-intl";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Tooltip } from "./tooltip";

/** Compact relative stamp ("4h ago"); the exact local date and time on hover. */
export function RelativeTime({ date }: { date: Date | string | number }) {
  const locale = useLocale();
  const d = new Date(date);
  return (
    <Tooltip inline text={formatDateTime(d, locale)}>
      {/* suppressHydrationWarning: server and client render moments differ */}
      <time dateTime={d.toISOString()} suppressHydrationWarning>
        {formatRelative(d, locale)}
      </time>
    </Tooltip>
  );
}
