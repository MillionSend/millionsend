"use client";

import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/status-badge";
import type { TONE_COLOR } from "@/components/status-tile";

export type DomainStatus = "pending" | "verified" | "temporary_failure" | "failed";
/** What the dashboard shows: the stored status, or partial for a verified domain whose tracking CNAME has not resolved. */
export type DisplayDomainStatus = DomainStatus | "partial";

/** Row-tile tone per status, matching the badge: verified green, partial info, the two waits warn, failed danger. */
export const DOMAIN_TONE: Record<DisplayDomainStatus, keyof typeof TONE_COLOR> = {
  verified: "success",
  partial: "info",
  pending: "warn",
  temporary_failure: "warn",
  failed: "danger",
};

/**
 * Verified means SES will send; a tracking subdomain still waiting for its
 * CNAME leaves links and opens untracked, which is worth a distinct word.
 */
export function displayDomainStatus(
  status: DomainStatus,
  trackingPending: boolean,
): DisplayDomainStatus {
  return status === "verified" && trackingPending ? "partial" : status;
}

/**
 * temporary_failure is domain-specific, so its label lives in the domains
 * catalog. A pending domain is warn (canvas), not the neutral shared pending.
 */
export function DomainStatusBadge({ status }: { status: DisplayDomainStatus }) {
  const t = useTranslations("domains");
  const common = useTranslations("common");
  if (status === "temporary_failure") {
    return <span className="ms-badge ms-badge-warn">{t("status.temporary_failure")}</span>;
  }
  if (status === "partial") {
    return <span className="ms-badge ms-badge-info">{common("status.partial")}</span>;
  }
  if (status === "pending") {
    return <span className="ms-badge ms-badge-warn">{common("status.pending")}</span>;
  }
  return <StatusBadge status={status} />;
}
