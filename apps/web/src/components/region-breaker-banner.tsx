"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { useTRPC } from "@/lib/trpc";

/**
 * One strip per SES region where the platform breaker holds broadcasts. The
 * query answers null for users who cannot act on it.
 */
export function RegionBreakerBanner() {
  const t = useTranslations("settings.ses.breaker");
  const trpc = useTRPC();
  const { data } = useQuery(trpc.system.platformBreakers.queryOptions());
  if (!data) return null;
  return (
    <>
      {data.map((r) => (
        <NoticeStrip
          key={r.region}
          tone="danger"
          text={t("paused", {
            region: r.region,
            metric: t(`metric.${r.reason?.metric ?? "complaint"}`),
            rate: ((r.reason?.rate ?? 0) * 100).toFixed(2),
          })}
        />
      ))}
    </>
  );
}
