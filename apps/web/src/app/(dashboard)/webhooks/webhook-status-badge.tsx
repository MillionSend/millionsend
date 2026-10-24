"use client";

import { useLocale, useTranslations } from "next-intl";
import { RelativeTime } from "@/components/relative-time";
import type { TONE_COLOR } from "@/components/status-tile";
import { Tooltip } from "@/components/tooltip";
import { formatRelative } from "@/lib/format";
import { QUEUE_COUNT_CAP } from "@/lib/webhook-queue";

export const queuedLabel = (queued: number): string =>
  queued > QUEUE_COUNT_CAP ? "10k+" : String(queued);

/**
 * One muted line about an endpoint's open deliveries: how many, and how long
 * the earliest has been due — or, when nothing is due yet, when the next
 * attempt is. Under the status on a detail page; `inline`, beside the badge
 * in a list row, the count alone with the rest of the line on hover.
 */
export function QueueLine({
  queued,
  oldestQueuedAt,
  inline = false,
}: {
  queued: number;
  oldestQueuedAt: Date | string | null;
  inline?: boolean;
}) {
  const t = useTranslations("webhooks");
  const locale = useLocale();
  if (queued === 0 || oldestQueuedAt === null) return null;
  const oldest = new Date(oldestQueuedAt);
  const due = oldest.getTime() <= Date.now();
  const count = t("queue.queued", { count: queuedLabel(queued) });
  const when = t(due ? "queue.oldest" : "queue.next");
  return inline ? (
    <Tooltip inline text={`${count} · ${when} ${formatRelative(oldest, locale)}`}>
      <span style={{ color: "var(--ms-muted)", fontSize: 12.5 }}>{count}</span>
    </Tooltip>
  ) : (
    <div style={{ marginTop: 4, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
      {count} · {when} <RelativeTime date={oldest} />
    </div>
  );
}

type EndpointStatus = "enabled" | "disabled" | "auto_disabled";

export const ENDPOINT_VARIANTS: Record<EndpointStatus, keyof typeof TONE_COLOR> = {
  enabled: "success",
  disabled: "neutral",
  // Auto-disable means deliveries kept failing — that deserves a warning tint.
  auto_disabled: "warn",
};

export function WebhookStatusBadge({ status }: { status: EndpointStatus }) {
  const t = useTranslations("webhooks");
  return (
    <span className={`ms-badge ms-badge-${ENDPOINT_VARIANTS[status]}`}>
      {t(`status.${status}`)}
    </span>
  );
}

export type DeliveryStatus = "pending" | "success" | "failed" | "exhausted";

export const DELIVERY_VARIANTS: Record<DeliveryStatus, keyof typeof TONE_COLOR> = {
  pending: "neutral",
  success: "success",
  failed: "danger",
  exhausted: "danger",
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useTranslations("webhooks");
  return (
    <span className={`ms-badge ms-badge-${DELIVERY_VARIANTS[status]}`}>
      {t(`deliveryStatus.${status}`)}
    </span>
  );
}
