"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc";

/**
 * Warn-only banner shown while no explicit AWS credentials are configured.
 * Submits stay allowed: the default provider chain may still supply
 * credentials at runtime, so this informs rather than blocks.
 */
export function AwsCredentialsBanner() {
  const t = useTranslations("domains");
  const trpc = useTRPC();
  const readiness = useQuery(trpc.system.awsReadiness.queryOptions());
  if (readiness.data?.credentialsConfigured !== false) return null;
  return (
    <div
      role="status"
      style={{
        border: "1px solid var(--ms-warn-border)",
        background: "var(--ms-warn-bg)",
        borderRadius: "var(--ms-r-input)",
        padding: "9px 14px",
        marginBottom: 18,
        fontSize: 13,
        lineHeight: 1.5,
        color: "var(--ms-warn)",
        maxWidth: 1000,
      }}
    >
      {t("awsCredentialsWarning")}
    </div>
  );
}
