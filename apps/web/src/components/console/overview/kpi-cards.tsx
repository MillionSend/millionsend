"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ChartDialog, PERIOD_KEYS, type PeriodKey } from "@/components/console/chart-dialog";
import { PopoverMenu } from "@/components/popover-menu";
import { Skeleton } from "@/components/skeleton";
import { Sparkline } from "@/components/sparkline";
import { formatPercent, formatSignedPercent } from "@/lib/console-format";
import { useTRPC } from "@/lib/trpc";
import {
  KPI_DECIMALS,
  KpiChart,
  type KpiKind,
  kpiColor,
  kpiFormatter,
  kpiValue,
  pointLabel,
} from "./charts";

const KPIS: { kind: KpiKind; initial: PeriodKey }[] = [
  { kind: "sent", initial: "24h" },
  { kind: "delivered", initial: "24h" },
  { kind: "bounced", initial: "7d" },
  { kind: "complained", initial: "7d" },
];

export function KpiCards() {
  return (
    <div className="ms-grid ms-grid-4" style={{ marginBottom: 16 }}>
      {KPIS.map((k) => (
        <KpiCard key={k.kind} kind={k.kind} initial={k.initial} />
      ))}
    </div>
  );
}

function KpiCard({ kind, initial }: { kind: KpiKind; initial: PeriodKey }) {
  const t = useTranslations("console.overview");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const trpc = useTRPC();
  const [period, setPeriod] = useState<PeriodKey>(initial);
  const [dialog, setDialog] = useState(false);
  const query = useQuery(trpc.console.overview.kpis.queryOptions({ period }));
  const data = query.data;
  const fmt = new Intl.NumberFormat(locale);
  const format = kpiFormatter(kind, locale);

  let headline: string | null = null;
  let sub: string | null = null;
  if (data) {
    const { totals, previous } = data;
    if (kind === "sent") {
      headline = fmt.format(totals.sent);
      sub =
        totals.sent === 0 && previous.sent === 0
          ? t("kpi.noSends")
          : common("vsPrevious", {
              delta:
                previous.sent === 0
                  ? common("none")
                  : formatSignedPercent((totals.sent - previous.sent) / previous.sent, locale, 1),
            });
    } else {
      headline = totals.sent > 0 ? format(kpiValue(kind, totals)) : common("none");
      sub =
        kind === "delivered"
          ? t("kpi.deliveredOf", {
              delivered: fmt.format(totals.delivered),
              sent: fmt.format(totals.sent),
            })
          : kind === "bounced"
            ? t("kpi.hardOf", {
                rate:
                  totals.sent > 0
                    ? formatPercent(totals.hardBounced / totals.sent, locale, KPI_DECIMALS.bounced)
                    : common("none"),
              })
            : t("kpi.complaintLines");
    }
  } else if (query.isError) {
    headline = common("none");
    sub = common("loadError");
  }

  const open = () => setDialog(true);
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: the card holds the period menu's own button, which a <button> could not nest */}
      <div
        className="ms-card ms-card-bleed"
        role="button"
        tabIndex={0}
        style={{ padding: 24, position: "relative", paddingBottom: 70, cursor: "pointer" }}
        onClick={(event) => {
          const target = event.target as Element;
          if (target.closest("button") || target.closest("[data-spark]")) return;
          open();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            // The menu trigger is a fixed 28px square; its wider period label
            // overflows it symmetrically, so the row keeps room on the right.
            paddingRight: 12,
          }}
        >
          <div className="ms-microlabel">{t(`kpi.${kind}`)}</div>
          <PopoverMenu
            ariaLabel={t("kpi.period")}
            triggerGlyph={
              <span
                className="ms-btn ms-btn-secondary"
                style={{
                  height: 24,
                  padding: "0 8px",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--ms-muted)",
                  alignItems: "center",
                  gap: 4,
                  whiteSpace: "nowrap",
                }}
              >
                {common(`periodShort.${period}`)}
                <span aria-hidden="true" style={{ fontSize: 10 }}>
                  ▾
                </span>
              </span>
            }
            items={[
              ...PERIOD_KEYS.map((key) => ({
                label: common(`period.${key}`),
                onSelect: () => setPeriod(key),
              })),
              null,
              { label: common("custom"), onSelect: open },
            ]}
          />
        </div>
        <div
          className="ms-digits"
          style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1, marginTop: 6, display: "flex" }}
        >
          {headline ?? <Skeleton width={120} height="1lh" />}
        </div>
        <div style={{ fontSize: 13, color: "var(--ms-muted)", marginTop: 4, display: "flex" }}>
          {sub ?? <Skeleton width={160} height="1lh" />}
        </div>
        {data ? (
          <div className="ms-bleed" data-spark="" style={{ height: 56 }}>
            <Sparkline
              values={data.points.map((p) => kpiValue(kind, p))}
              labels={data.points.map((p) => pointLabel(p.t, data.grain, locale))}
              formatValue={format}
              color={kpiColor(kind)}
              height={56}
              {...(kind === "sent" ? { min: 0 } : {})}
            />
          </div>
        ) : null}
      </div>
      {dialog ? (
        <ChartDialog
          open
          onClose={() => setDialog(false)}
          title={t(`charts.${kind}`)}
          initialPeriod={period}
        >
          {(p) => <KpiChart kind={kind} period={p} />}
        </ChartDialog>
      ) : null}
    </>
  );
}
