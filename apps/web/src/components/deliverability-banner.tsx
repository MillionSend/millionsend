"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { useTRPC } from "@/lib/trpc";

/**
 * Global deliverability notice. Renders nothing while the health query is
 * unresolved or "ok" (a thin strip needs no ghost — it would itself be the
 * layout shift it means to avoid). "warning" is an amber nudge; "paused" is a
 * red strip that mirrors the send guard's block. Both link to /metrics.
 */
export function DeliverabilityBanner() {
  const t = useTranslations("deliverability");
  const locale = useLocale();
  const trpc = useTRPC();
  const { data } = useQuery(trpc.metrics.health.queryOptions());

  if (!data || data.status === "ok") return null;

  const reason =
    data.status === "paused"
      ? data.reasons.find((r) => r.tier === "paused")
      : data.reasons.find((r) => r.tier === "warning");
  if (!reason) return null;

  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  const limit =
    reason.metric === "bounce" ? data.thresholds.pauseBounce : data.thresholds.pauseComplaint;
  const paused = data.status === "paused";
  const text = t(`banner.${data.status}.${reason.metric}`, {
    rate: pct.format(reason.rate),
    limit: pct.format(limit),
  });

  return (
    <NoticeStrip
      href="/metrics"
      tone={paused ? "danger" : "warn"}
      text={text}
      action={t("banner.action")}
    />
  );
}
