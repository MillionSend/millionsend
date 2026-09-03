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
  canceled: "neutral",
} as const;

export type BadgeStatus = keyof typeof VARIANTS;
export type BadgeTone = (typeof VARIANTS)[BadgeStatus];

// Dot hues live in tokens/colors.css (--ms-dot-*); statuses without an email
// dot token borrow the family they read as: verified is a delivered-green,
// pending an in-flight gray.
const DOT_COLORS: Record<BadgeStatus, string> = {
  delivered: "var(--ms-dot-delivered)",
  verified: "var(--ms-dot-delivered)",
  sent: "var(--ms-dot-sent)",
  opened: "var(--ms-dot-opened)",
  clicked: "var(--ms-dot-clicked)",
  queued: "var(--ms-dot-queued)",
  queued_quota: "var(--ms-dot-queued-quota)",
  pending: "var(--ms-dot-queued)",
  delivery_delayed: "var(--ms-dot-delivery-delayed)",
  suppressed: "var(--ms-dot-suppressed)",
  bounced: "var(--ms-dot-bounced)",
  complained: "var(--ms-dot-complained)",
  failed: "var(--ms-dot-failed)",
  // Terminal but benign: borrows the queued gray rather than a danger hue.
  canceled: "var(--ms-dot-queued)",
};

/** 8px status dot — by email status or any CSS color; with neither it renders
 * the ring that marks an unfiltered "all" option. */
export function StatusDot({ status, color }: { status?: BadgeStatus; color?: string }) {
  const fill = status ? DOT_COLORS[status] : color;
  return fill ? (
    <span className="ms-dot" style={{ background: fill }} aria-hidden="true" />
  ) : (
    <span className="ms-dot ring" aria-hidden="true" />
  );
}

/** Labels come from common.status.* — semantic colors always carry text. */
export function StatusBadge({ status }: { status: BadgeStatus }) {
  const t = useTranslations("common");
  return <span className={`ms-badge ms-badge-${VARIANTS[status]}`}>{t(`status.${status}`)}</span>;
}
