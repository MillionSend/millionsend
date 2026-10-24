"use client";

import type { RevealSpan } from "@millionsend/core/content-reveal";
import type { TeamFlagDetail } from "@millionsend/db/schema";
import { useLocale, useTranslations } from "next-intl";
import { type DomainRegion, regionFlag } from "@/app/(dashboard)/domains/regions";
import { Tooltip } from "@/components/tooltip";
import { planLabel } from "@/lib/console-format";
import { formatRisk, riskColor } from "@/lib/monitor-settings";
import { formatScoreTenths } from "@/lib/score-band";

export type FlagReason =
  | "monitor"
  | "complaints"
  | "guardrail"
  | "score"
  | "report"
  | "manual"
  | "brand"
  | "linked";

// What makes each email wait: a hold or a verdict the operator decides on,
// or a judge or reader that could not answer.
export const WHY_DOT: Record<string, string> = {
  held: "var(--ms-warn)",
  verdict: "var(--ms-warn)",
  destination: "var(--ms-warn)",
  recipient: "var(--ms-warn)",
  outage: "var(--ms-danger)",
  media: "var(--ms-danger)",
};

/** A row action drawn as a link: a button with the text's own font and no box. */
export const LINK_BUTTON: React.CSSProperties = {
  font: "inherit",
  padding: 0,
  background: "none",
  border: 0,
  cursor: "pointer",
};

const PLAN_KEYS = ["free", "starter", "pro", "scale", "system"];

/** "Pro 100K" when a quota is set, else the plan name; unknown plan values read raw. */
export function usePlanLabel(): (plan: string, planQuota: number | null) => string {
  const t = useTranslations("console.plan");
  return (plan, planQuota) => planLabel(PLAN_KEYS.includes(plan) ? t(plan) : plan, planQuota);
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
    case "monitor":
      label = t("reasonLabel.monitor", {
        risk: formatRisk(detail?.risk ?? 0),
        samples: detail?.samples ?? 0,
      });
      break;
    case "brand":
      label = t("reasonLabel.brand", { brand: detail?.brand ?? "" });
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
  flush = false,
}: {
  title: string;
  subtitle?: string;
  /** For a padding-0 card holding a table: the head carries its own padding and rule. */
  inset?: boolean;
  /** No bottom margin: the enclosing row carries the spacing, so actions that
   * wrap under the subtitle keep the same distance to what follows. */
  flush?: boolean;
}) {
  return (
    <div
      style={
        inset
          ? { padding: "16px 20px 12px", borderBottom: "1px solid var(--ms-line)" }
          : flush
            ? undefined
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

/** The internal monitor risk, two decimals; "exempt" for a system team, a dash before the first sample. */
export function RiskCell({
  risk,
  plan,
  thresholds,
}: {
  risk: number | null;
  plan: string;
  /** The configured flag and alert lines the colour follows. */
  thresholds?: { flagRisk: number; alertRisk: number } | undefined;
}) {
  const t = useTranslations("console.safety");
  const common = useTranslations("console.common");
  if (plan === "system") return <span style={{ color: "var(--ms-muted)" }}>{t("exempt")}</span>;
  if (risk === null) return <>{common("none")}</>;
  return (
    <span style={{ color: riskColor(risk, thresholds?.flagRisk, thresholds?.alertRisk) }}>
      {formatRisk(risk)}
    </span>
  );
}

/** Where a span starts: the text is one immutable string, so an offset is identity. */
function keyedSpans(spans: RevealSpan[]): { key: string; span: RevealSpan }[] {
  let offset = 0;
  return spans.map((span) => {
    const key = String(offset);
    offset += span.text.length;
    return { key, span };
  });
}

/** Text the server redacted, a masked or shortened run marked as such. */
export function RevealText({ spans }: { spans: RevealSpan[] }) {
  return keyedSpans(spans).map(({ key, span }) => (
    <span key={key} className={span.redacted ? "ms-redact" : undefined}>
      {span.text}
    </span>
  ));
}
