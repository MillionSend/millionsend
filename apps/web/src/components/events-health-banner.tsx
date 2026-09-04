"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { useTRPC } from "@/lib/trpc";

/**
 * Instance-wide notice that SES events stopped arriving (sends went out, nothing
 * came back). The query answers null for users who cannot act on it.
 */
export function EventsHealthBanner() {
  const t = useTranslations("settings.ses");
  const trpc = useTRPC();
  const { data } = useQuery(trpc.system.eventsHealth.queryOptions(undefined, { retry: false }));
  if (data?.status !== "unhealthy") return null;
  return (
    <NoticeStrip
      tone="warn"
      text={t("events.unhealthy", { sent: data.sentInWindow })}
      {...(data.settingsAvailable
        ? { href: "/settings/ses", action: t("events.bannerAction") }
        : {})}
    />
  );
}
