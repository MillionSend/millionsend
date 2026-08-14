import { useTranslations } from "next-intl";

// Variant per status follows the design canvas exactly: sent reads as success
// (accepted for delivery), complained warns, delayed stays neutral, and
// suppressed is a danger — future sends are blocked.
const VARIANTS = {
  delivered: "success",
  verified: "success",
  sent: "success",
  opened: "info",
  clicked: "info",
  queued: "neutral",
  queued_quota: "neutral",
  pending: "neutral",
  delivery_delayed: "neutral",
  suppressed: "danger",
  bounced: "danger",
  complained: "warn",
  failed: "danger",
} as const;

export type BadgeStatus = keyof typeof VARIANTS;

/** Labels come from common.status.* — semantic colors always carry text. */
export function StatusBadge({ status }: { status: BadgeStatus }) {
  const t = useTranslations("common");
  return <span className={`ms-badge ms-badge-${VARIANTS[status]}`}>{t(`status.${status}`)}</span>;
}
