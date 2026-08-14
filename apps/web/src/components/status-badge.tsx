import { useTranslations } from "next-intl";

const VARIANTS = {
  delivered: "success",
  verified: "success",
  sent: "info",
  opened: "info",
  clicked: "info",
  queued: "neutral",
  queued_quota: "neutral",
  pending: "neutral",
  delivery_delayed: "warn",
  suppressed: "warn",
  bounced: "danger",
  complained: "danger",
  failed: "danger",
} as const;

export type BadgeStatus = keyof typeof VARIANTS;

/** Labels come from common.status.* — semantic colors always carry text. */
export function StatusBadge({ status }: { status: BadgeStatus }) {
  const t = useTranslations("common");
  return <span className={`ms-badge ms-badge-${VARIANTS[status]}`}>{t(`status.${status}`)}</span>;
}
