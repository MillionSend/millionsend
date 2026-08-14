"use client";

import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/status-badge";

export type DomainStatus = "pending" | "verified" | "temporary_failure" | "failed";

/**
 * temporary_failure is domain-specific, so its label lives in the domains
 * catalog. A pending domain is warn (canvas), not the neutral shared pending.
 */
export function DomainStatusBadge({ status }: { status: DomainStatus }) {
  const t = useTranslations("domains");
  const common = useTranslations("common");
  if (status === "temporary_failure") {
    return <span className="ms-badge ms-badge-warn">{t("status.temporary_failure")}</span>;
  }
  if (status === "pending") {
    return <span className="ms-badge ms-badge-warn">{common("status.pending")}</span>;
  }
  return <StatusBadge status={status} />;
}
