"use client";

import { useLocale, useTranslations } from "next-intl";
import { regionFlag } from "@/app/(dashboard)/domains/regions";
import { Tooltip } from "@/components/tooltip";
import { formatPercent, planLabel, planTone } from "@/lib/console-format";
import { formatDay } from "@/lib/format";
import { StatusText } from "../regions/region-cells";

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

/** A guardrail standing's dot. */
export const GUARDRAIL_TONE = { ok: "success", warning: "warn", paused: "danger" } as const;

/** What a team's status cell reads: its holds, its pause and its guardrail standing. */
export interface TeamStatusFields {
  suspendedAt: Date | null;
  suspensionReason: "manual" | "reputation" | "phishing" | "non_payment" | "review" | null;
  broadcastsPausedByOperatorAt: Date | null;
  guardrail: keyof typeof GUARDRAIL_TONE | null;
  guardrailMetric: "complaint" | "hard_bounce" | null;
  complaintRate7d: number | null;
  hardBounceRate7d: number | null;
}

/**
 * A team's state now, as a dot and one or two words with the reason one
 * hover away. The first that holds wins: a review hold, a suspension, the
 * operator's broadcast pause, then the guardrail; a team without a standing
 * row reads as ok.
 */
export function TeamStatus({ team }: { team: TeamStatusFields }) {
  const t = useTranslations("console.teams");
  const safety = useTranslations("console.safety");
  const overview = useTranslations("console.overview");
  const locale = useLocale();
  if (team.suspendedAt) {
    const day = formatDay(team.suspendedAt, locale);
    if (team.suspensionReason === "review") {
      return (
        <StatusText
          tone="warn"
          text={t("guardrail.review")}
          tip={t("guardrail.reviewTip", { day })}
        />
      );
    }
    const why =
      team.suspensionReason && team.suspensionReason !== "manual"
        ? ` · ${t(`suspendDialog.reasons.${team.suspensionReason}`)}`
        : "";
    return (
      <StatusText
        tone="danger"
        text={t("guardrail.suspended")}
        tip={`${t("guardrail.suspendedTip", { day })}${why}`}
      />
    );
  }
  if (team.broadcastsPausedByOperatorAt) {
    return (
      <StatusText
        tone="danger"
        text={t("guardrail.paused")}
        tip={`${safety("review.badges.operatorPaused")}\n${overview("regions.pauseTransactional")}`}
      />
    );
  }
  const guardrail = team.guardrail ?? "ok";
  if (guardrail === "ok") return <StatusText tone="success" text={t("guardrail.ok")} />;
  const label = guardrail === "paused" ? "guardrailPaused" : "guardrailWarning";
  const metric = team.guardrailMetric;
  const rate = metric === "hard_bounce" ? team.hardBounceRate7d : team.complaintRate7d;
  return (
    <StatusText
      tone={GUARDRAIL_TONE[guardrail]}
      text={t(`guardrail.${guardrail}`)}
      tip={
        metric && rate !== null
          ? `${safety(`reasonLabel.${label}`, {
              metric: safety(`metric.${metric}`),
              rate: formatPercent(rate, locale, 2),
            })}\n${t("guardrail.window", { metric })}`
          : safety(`review.badges.${label}`)
      }
    />
  );
}
