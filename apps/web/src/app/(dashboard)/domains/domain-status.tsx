"use client";

import { useTranslations } from "next-intl";
import { NavIcon } from "@/components/nav-icon";
import { StatusBadge } from "@/components/status-badge";

export type DomainStatus = "pending" | "verified" | "temporary_failure" | "failed";

/** temporary_failure is domain-specific, so its label lives in the domains catalog. */
export function DomainStatusBadge({ status }: { status: DomainStatus }) {
  const t = useTranslations("domains");
  if (status === "temporary_failure") {
    return <span className="ms-badge ms-badge-warn">{t("status.temporary_failure")}</span>;
  }
  return <StatusBadge status={status} />;
}

const TILE_TINT: Record<DomainStatus, { color: string; bg: string; border: string }> = {
  verified: {
    color: "var(--ms-success)",
    bg: "var(--ms-success-bg)",
    border: "var(--ms-success-border)",
  },
  pending: { color: "var(--ms-warn)", bg: "var(--ms-warn-bg)", border: "var(--ms-warn-border)" },
  temporary_failure: {
    color: "var(--ms-warn)",
    bg: "var(--ms-warn-bg)",
    border: "var(--ms-warn-border)",
  },
  failed: {
    color: "var(--ms-danger)",
    bg: "var(--ms-danger-bg)",
    border: "var(--ms-danger-border)",
  },
};

/** Globe tile tinted by verification status; the badge next to it carries the words. */
export function DomainTile({ status }: { status: DomainStatus }) {
  const tint = TILE_TINT[status];
  return (
    <span
      aria-hidden="true"
      style={{
        width: 32,
        height: 32,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--ms-r-input)",
        color: tint.color,
        background: tint.bg,
        border: `1px solid ${tint.border}`,
      }}
    >
      <NavIcon name="domains" />
    </span>
  );
}
