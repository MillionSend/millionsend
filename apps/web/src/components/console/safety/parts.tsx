"use client";

import type { TeamFlagDetail } from "@millionsend/db/schema";
import { useLocale, useTranslations } from "next-intl";
import { type DomainRegion, regionFlag } from "@/app/(dashboard)/domains/regions";
import { Tooltip } from "@/components/tooltip";
import { planLabel } from "@/lib/console-format";
import { formatScoreTenths } from "@/lib/score-band";

export type Guardrail = "ok" | "warning" | "paused";
export type FlagReason = "monitor" | "complaints" | "guardrail" | "score" | "report" | "manual";

const PAID = ["starter", "pro", "scale"];
const PLAN_KEYS = ["free", "starter", "pro", "scale", "system"];

/** "Pro 100K" when a quota is set, else the plan name; unknown plan values read raw. */
export function usePlanLabel(): (plan: string, planQuota: number | null) => string {
  const t = useTranslations("console.plan");
  return (plan, planQuota) => planLabel(PLAN_KEYS.includes(plan) ? t(plan) : plan, planQuota);
}

/** Plan pill: info for system, success for paid, neutral for free and unknown values. */
export function PlanBadge({ plan, planQuota }: { plan: string; planQuota: number | null }) {
  const label = usePlanLabel();
  const tone = plan === "system" ? "info" : PAID.includes(plan) ? "success" : "neutral";
  return <span className={`ms-badge ms-badge-${tone}`}>{label(plan, planQuota)}</span>;
}

export function usePercent(): (rate: number) => string {
  const locale = useLocale();
  return (rate) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(rate);
}

export function scoreColor(tenths: number): string | undefined {
  return tenths < 50 ? "var(--ms-danger)" : tenths < 70 ? "var(--ms-warn)" : undefined;
}

const DOT: Record<Guardrail, string> = {
  ok: "var(--ms-success)",
  warning: "var(--ms-warn)",
  paused: "var(--ms-danger)",
};

/** Suspended badge, operator-paused dot, or the guardrail dot — the Teams screen's rules. */
export function GuardrailCell({
  guardrail,
  suspendedAt,
  pausedAt,
}: {
  guardrail: Guardrail | null;
  suspendedAt: Date | null;
  pausedAt: Date | null;
}) {
  const t = useTranslations("console.teams.guardrail");
  const common = useTranslations("console.common");
  if (suspendedAt) return <span className="ms-badge ms-badge-danger">{t("suspended")}</span>;
  const dot = (color: string, label: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="ms-dot" style={{ background: color }} />
      {label}
    </span>
  );
  if (pausedAt) return dot(DOT.paused, t("operatorPaused"));
  if (!guardrail) return <>{common("none")}</>;
  return dot(DOT[guardrail], t(guardrail));
}

/** Flag + city with the region code on hover; the "no verified domain" line when null. */
export function RegionCell({ region }: { region: string | null }) {
  const domains = useTranslations("domains");
  const common = useTranslations("console.common");
  if (!region) return <span style={{ color: "var(--ms-muted)" }}>{common("unknownRegion")}</span>;
  return (
    <Tooltip inline text={region}>
      {regionFlag(region)} {domains(`regions.${region as DomainRegion}`)}
    </Tooltip>
  );
}

/** The flag's human label from its reason and measurement, with the reason's explanation on hover. */
export function ReasonLabel({
  reason,
  detail,
}: {
  reason: FlagReason;
  detail: TeamFlagDetail | null;
}) {
  const t = useTranslations("console.safety");
  const locale = useLocale();
  const percent = usePercent();
  const rate = percent(detail?.rate ?? 0);
  let label: string;
  switch (reason) {
    case "complaints":
      label = t(`reasonLabel.${detail?.metric === "hard_bounce" ? "hard_bounce" : "complaint"}`, {
        rate,
      });
      break;
    case "guardrail":
      label = t(
        `reasonLabel.${detail?.guardrail === "paused" ? "guardrailPaused" : "guardrailWarning"}`,
        {
          metric: t(`metric.${detail?.metric === "hard_bounce" ? "hard_bounce" : "complaint"}`),
          rate,
        },
      );
      break;
    case "score":
      label = t("reasonLabel.score", {
        score: formatScoreTenths(detail?.scoreTenths ?? 0, locale),
      });
      break;
    default:
      label = t(`reasonLabel.${reason}`);
  }
  return (
    <Tooltip inline text={t(`reasonTip.${reason}`)}>
      {label}
    </Tooltip>
  );
}

/** Suspended beats the flag's own status. */
export function FlagStatusBadge({
  status,
  suspendedAt,
}: {
  status: "open" | "cleared";
  suspendedAt: Date | null;
}) {
  const t = useTranslations("console.safety.status");
  if (suspendedAt) return <span className="ms-badge ms-badge-danger">{t("suspended")}</span>;
  return status === "open" ? (
    <span className="ms-badge ms-badge-warn">{t("open")}</span>
  ) : (
    <span className="ms-badge ms-badge-neutral">{t("cleared")}</span>
  );
}

/** Failed load: the headline and one Retry, the Emails list's StateCard shape. */
export function LoadErrorCard({ onRetry }: { onRetry: () => void }) {
  const common = useTranslations("console.common");
  return (
    <div className="ms-card ms-state">
      <span className="ms-state-glyph" aria-hidden="true">
        !
      </span>
      <p className="ms-state-headline">{common("loadError")}</p>
      <div className="ms-state-actions">
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onRetry}>
          {common("retry")}
        </button>
      </div>
    </div>
  );
}

/** A card's title row: display title, muted one-line subtitle. */
export function CardHead({
  title,
  subtitle,
  inset = false,
}: {
  title: string;
  subtitle?: string;
  /** For a padding-0 card holding a table: the head carries its own padding and rule. */
  inset?: boolean;
}) {
  return (
    <div
      style={
        inset
          ? { padding: "16px 20px 12px", borderBottom: "1px solid var(--ms-line)" }
          : { marginBottom: 16 }
      }
    >
      <h3
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: 0 }}
      >
        {title}
      </h3>
      {subtitle ? (
        <p style={{ margin: "4px 0 0", fontSize: "var(--ms-fs-label)", color: "var(--ms-muted)" }}>
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
