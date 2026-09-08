"use client";

import { useTranslations } from "next-intl";
import { RelativeTime } from "@/components/relative-time";
import type { TONE_COLOR } from "@/components/status-tile";
import { QUEUE_COUNT_CAP } from "@/lib/webhook-queue";

export const queuedLabel = (queued: number): string =>
  queued > QUEUE_COUNT_CAP ? "10k+" : String(queued);

/**
 * One muted line under an endpoint with open deliveries: how many, and how
 * long the earliest has been due — or, when nothing is due yet, when the
 * next attempt is.
 */
export function QueueLine({
  queued,
  oldestQueuedAt,
}: {
  queued: number;
  oldestQueuedAt: Date | string | null;
}) {
  const t = useTranslations("webhooks");
  if (queued === 0 || oldestQueuedAt === null) return null;
  const oldest = new Date(oldestQueuedAt);
  const due = oldest.getTime() <= Date.now();
  return (
    <div style={{ marginTop: 4, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
      {t("queue.queued", { count: queuedLabel(queued) })} · {t(due ? "queue.oldest" : "queue.next")}{" "}
      <RelativeTime date={oldest} />
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

type DeliveryStatus = "pending" | "success" | "failed" | "exhausted";

const DELIVERY_VARIANTS: Record<DeliveryStatus, string> = {
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
