"use client";

import { useTranslations } from "next-intl";

type EndpointStatus = "enabled" | "disabled" | "auto_disabled";

const ENDPOINT_VARIANTS: Record<EndpointStatus, string> = {
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
