import type { BadgeStatus } from "@/components/status-badge";

// Mirrors the status→variant families kept private in
// components/status-badge.tsx; the tile tints the row's leading glyph with
// the same family the badge uses.
const VARIANTS: Record<BadgeStatus, "success" | "info" | "warn" | "danger" | "neutral"> = {
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
};

/** Status-tinted envelope square leading an email row; decorative — the badge carries the label. */
export function EnvelopeTile({ status }: { status: BadgeStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`ms-badge-${VARIANTS[status]}`}
      style={{
        width: 26,
        height: 26,
        border: "1px solid",
        borderRadius: "var(--ms-r-chip)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      ✉
    </span>
  );
}
