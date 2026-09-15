"use client";

import { useTranslations } from "next-intl";
import { regionFlag } from "@/app/(dashboard)/domains/regions";
import { Tooltip } from "@/components/tooltip";
import { planLabel, planTone } from "@/lib/console-format";

/** The translated plan name; a value the catalog does not know prints raw. */
export function usePlanName(): (plan: string) => string {
  const t = useTranslations("console.plan");
  return (plan) => (t.has(plan) ? t(plan) : plan);
}

export function PlanBadge({ plan, planQuota }: { plan: string; planQuota: number | null }) {
  const name = usePlanName();
  return (
    <span className={`ms-badge ms-badge-${planTone(plan)}`}>
      {planLabel(name(plan), planQuota)}
    </span>
  );
}

/** Flag + city with the region code on hover; a team without a verified domain has no region. */
export function RegionLabel({ region }: { region: string | null }) {
  const domains = useTranslations("domains");
  const common = useTranslations("console.common");
  if (!region) return <span style={{ color: "var(--ms-muted)" }}>{common("unknownRegion")}</span>;
  const city = domains.has(`regions.${region}`) ? domains(`regions.${region}`) : region;
  return (
    <Tooltip inline text={region}>
      {regionFlag(region)} {city}
    </Tooltip>
  );
}

const GUARDRAIL_COLOR: Record<string, string> = {
  ok: "var(--ms-success)",
  warning: "var(--ms-warn)",
  paused: "var(--ms-danger)",
};

/**
 * Suspended beats an operator pause beats the guardrail; a team without a
 * standing row reads as ok.
 */
export function GuardrailLabel({
  guardrail,
  suspendedAt,
  broadcastsPausedByOperatorAt,
}: {
  guardrail: string | null;
  suspendedAt: Date | null;
  broadcastsPausedByOperatorAt: Date | null;
}) {
  const t = useTranslations("console.teams.guardrail");
  if (suspendedAt) return <span className="ms-badge ms-badge-danger">{t("suspended")}</span>;
  const status = broadcastsPausedByOperatorAt ? "paused" : (guardrail ?? "ok");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="ms-dot" style={{ background: GUARDRAIL_COLOR[status] }} aria-hidden="true" />
      {broadcastsPausedByOperatorAt ? t("operatorPaused") : t(status)}
    </span>
  );
}
