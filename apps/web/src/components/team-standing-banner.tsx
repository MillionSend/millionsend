"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { formatDayTime } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

/**
 * What the instance operator did to this team: a suspension shows on every
 * page (sends are refused), a review hold as a neutral pause, an operator
 * pause of broadcasts only on the Broadcasts pages, where it explains why
 * nothing goes out.
 */
export function TeamStandingBanner() {
  const t = useTranslations("console.banner");
  const locale = useLocale();
  const pathname = usePathname();
  const trpc = useTRPC();
  const { data } = useQuery(trpc.team.standing.queryOptions());
  if (!data) return null;
  if (data.suspended?.reason === "review") {
    return (
      <NoticeStrip
        tone="warn"
        text={t("sendingPendingReview", { since: formatDayTime(data.suspended.at, locale) })}
      />
    );
  }
  if (data.suspended) {
    const { reason, note } = data.suspended;
    return (
      <NoticeStrip
        tone="danger"
        text={
          note && reason === "manual"
            ? t("suspendedNote", { note })
            : t("suspended", { reason: t(`reasons.${reason}`) })
        }
      />
    );
  }
  if (data.broadcastsPausedByOperatorAt && pathname.startsWith("/broadcasts")) {
    return (
      <NoticeStrip
        tone="warn"
        text={t(data.pendingReview ? "broadcastsPendingReview" : "broadcastsPaused", {
          since: formatDayTime(data.broadcastsPausedByOperatorAt, locale),
        })}
      />
    );
  }
  return null;
}
