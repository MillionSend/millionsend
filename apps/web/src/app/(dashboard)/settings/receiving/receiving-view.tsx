"use client";

import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { KvRow } from "@/components/kv-row";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section-card";
import { Skeleton } from "@/components/skeleton";
import { formatBytes } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";

/** How this instance takes mail, read-only, for its operator. */
export function ReceivingView() {
  const t = useTranslations("inboxes");
  const locale = useLocale();
  const trpc = useTRPC();
  const health = useQuery(trpc.receiving.health.queryOptions(undefined, { retry: false }));
  // Anyone but the operator gets the page a missing route gives.
  if (trpcErrorCode(health.error) === "NOT_FOUND") notFound();
  const data = health.data;
  const none = t("settingsReceiving.off");
  return (
    <div style={{ maxWidth: 640 }}>
      <SectionCard title={t("settingsReceiving.title")}>
        {data ? (
          <dl className="ms-kv">
            <KvRow label={t("settingsReceiving.mxHost")}>
              <span className="ms-mono">{data.mxHost ?? none}</span>
            </KvRow>
            <KvRow label={t("settingsReceiving.lastMessage")}>
              {data.lastMessageAt ? <RelativeTime date={data.lastMessageAt} /> : "—"}
            </KvRow>
            <KvRow label={t("settingsReceiving.receivedToday")}>
              <span className="ms-digits">
                {new Intl.NumberFormat(locale).format(data.receivedToday)}
              </span>
            </KvRow>
            <KvRow label={t("settingsReceiving.virus")}>
              <span className="ms-mono">{data.clamavHost ?? none}</span>
            </KvRow>
            <KvRow label={t("settingsReceiving.sharedDomain")}>
              <span className="ms-mono">{data.sharedInboxDomain ?? none}</span>
            </KvRow>
            <KvRow label={t("settingsReceiving.maxSize")}>{formatBytes(data.maxSizeBytes)}</KvRow>
          </dl>
        ) : (
          <Skeleton width="60%" height={14} />
        )}
      </SectionCard>
    </div>
  );
}
