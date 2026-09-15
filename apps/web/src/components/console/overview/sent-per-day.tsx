"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { type Period, PeriodBar } from "@/components/console/chart-dialog";
import { LineChart, type LineChartSeries } from "@/components/line-chart";
import { Skeleton } from "@/components/skeleton";
import { Tooltip } from "@/components/tooltip";
import { useTRPC } from "@/lib/trpc";
import { pointLabel } from "./charts";

const HEIGHT = 228;

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-block", width: 14, height: 2, background: color, flex: "none" }}
    />
  );
}

export function SentPerDay() {
  const t = useTranslations("console.overview.sent");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const trpc = useTRPC();
  const [period, setPeriod] = useState<Period>("30d");
  const query = useQuery(trpc.console.overview.sentPerDay.queryOptions({ period }));
  const data = query.data;
  const fmt = new Intl.NumberFormat(locale);
  const hourly = data?.grain === "hour";

  const legend: { key: string; label: string; tip: string; color: string; value: number | null }[] =
    [
      {
        key: "sent",
        label: t("legendSent"),
        tip: t("legendSentTip"),
        color: "var(--ms-steel)",
        value: null,
      },
    ];
  if (data && data.committedPerDay !== null) {
    legend.push({
      key: "committed",
      label: t("legendCommitted"),
      tip: t("legendCommittedTip"),
      color: "var(--ms-muted)",
      value: data.committedPerDay,
    });
  }
  for (const q of data?.quotas ?? []) {
    legend.push({
      key: `quota-${q.region}`,
      label: t("legendQuota", { region: q.region }),
      tip: t("legendQuotaTip"),
      color: "var(--ms-line-strong)",
      value: q.max24h,
    });
  }
  // The reference lines are daily figures; an hourly chart has no day to compare against.
  const shown = legend.filter((entry) => entry.value === null || !hourly);
  const series: LineChartSeries[] = data
    ? shown.map((entry) => ({
        key: entry.key,
        label: entry.label,
        color: entry.color,
        values: data.points.map((p) => (entry.value === null ? p.sent : entry.value)),
        ...(entry.key === "sent" ? { area: true } : {}),
      }))
    : [];

  return (
    <div className="ms-card" style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div>
          <h3 className="ms-display" style={{ fontSize: 22, margin: 0, fontWeight: 500 }}>
            {hourly ? t("titleHourly") : t("title")}
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("subtitle")}
          </p>
        </div>
        <PeriodBar value={period} onChange={setPeriod} />
      </div>
      {query.isError ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{common("loadError")}</p>
      ) : !data ? (
        <Skeleton width="100%" height={HEIGHT} radius="var(--ms-r-input)" />
      ) : (
        <LineChart
          days={data.points.map((p) => p.t)}
          height={HEIGHT}
          series={series}
          formatDay={(day) => pointLabel(day, data.grain, locale)}
          formatValue={(v) => fmt.format(v)}
        />
      )}
      <div
        style={{
          display: "flex",
          gap: 18,
          flexWrap: "wrap",
          marginTop: 12,
          fontSize: 12,
          color: "var(--ms-muted)",
        }}
      >
        {shown.map((entry) => (
          <Tooltip key={entry.key} inline text={entry.tip}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Swatch color={entry.color} />
              {entry.label}
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
