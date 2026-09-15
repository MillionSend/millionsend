"use client";

import type { ProbeKey } from "@millionsend/core";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { Period } from "@/components/console/chart-dialog";
import { LineChart } from "@/components/line-chart";
import { Skeleton } from "@/components/skeleton";
import { formatHourMinute, formatPercent, periodDayKeys } from "@/lib/console-format";
import { formatDayTime, formatDayUtc } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

export type KpiKind = "sent" | "delivered" | "bounced" | "complained";

export const KPI_DECIMALS: Record<Exclude<KpiKind, "sent">, number> = {
  delivered: 1,
  bounced: 2,
  complained: 3,
};

export function kpiColor(kind: KpiKind): string {
  return kind === "sent" || kind === "delivered" ? "var(--ms-steel)" : "var(--ms-muted)";
}

interface Counters {
  sent: number;
  delivered: number;
  bounced: number;
  hardBounced: number;
  complained: number;
}

/** A KPI's value for one point or a total: the count for sent, a ratio of sent otherwise. */
export function kpiValue(kind: KpiKind, p: Counters): number {
  if (kind === "sent") return p.sent;
  return p.sent === 0 ? 0 : p[kind] / p.sent;
}

export function kpiFormatter(kind: KpiKind, locale: string): (value: number) => string {
  if (kind === "sent") {
    const fmt = new Intl.NumberFormat(locale);
    return (v) => fmt.format(v);
  }
  return (v) => formatPercent(v, locale, KPI_DECIMALS[kind]);
}

/**
 * The line chart's ticks are integer counts, so a ratio series is plotted
 * per million and formatted back; the axis still lands on round numbers.
 */
export const RATE_SCALE = 1_000_000;

/** Axis/tooltip label for a series point: the hour for hourly grains, else the UTC day. */
export function pointLabel(t: string, grain: "hour" | "day", locale: string): string {
  return grain === "hour" ? formatHourMinute(t, locale) : formatDayUtc(t, locale);
}

export function periodLabel(period: Period, common: (key: string) => string): string {
  return typeof period === "string" ? common(`period.${period}`) : `${period.from} → ${period.to}`;
}

const CHART_HEIGHT = 228;

function ChartSkeleton() {
  return <Skeleton width="100%" height={CHART_HEIGHT} radius="var(--ms-r-input)" />;
}

function ChartNote({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>{children}</p>;
}

function Empty() {
  const t = useTranslations("console.overview.charts");
  return (
    <div
      style={{
        height: CHART_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ms-muted)",
        fontSize: 13,
      }}
    >
      {t("noPoints")}
    </div>
  );
}

function LoadError() {
  const common = useTranslations("console.common");
  return <ChartNote>{common("loadError")}</ChartNote>;
}

/** One KPI over the dialog's period, with its total (sent) or average (rates) under the chart. */
export function KpiChart({ kind, period }: { kind: KpiKind; period: Period }) {
  const t = useTranslations("console.overview");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.overview.kpis.queryOptions({ period }));
  if (query.isError) return <LoadError />;
  const data = query.data;
  if (!data) return <ChartSkeleton />;
  const scale = kind === "sent" ? 1 : RATE_SCALE;
  const format = kpiFormatter(kind, locale);
  const aggregate = kpiValue(kind, data.totals);
  return (
    <>
      {data.points.length === 0 ? (
        <Empty />
      ) : (
        <LineChart
          days={data.points.map((p) => p.t)}
          height={CHART_HEIGHT}
          series={[
            {
              key: kind,
              label: t(`kpi.${kind}`),
              color: kpiColor(kind),
              values: data.points.map((p) => kpiValue(kind, p) * scale),
              area: true,
            },
          ]}
          formatDay={(day) => pointLabel(day, data.grain, locale)}
          formatValue={(v) => format(v / scale)}
        />
      )}
      <ChartNote>
        {periodLabel(period, common)} · {common(kind === "sent" ? "total" : "average")}{" "}
        {format(aggregate)}
      </ChartNote>
    </>
  );
}

/** One probe's bucketed history; `scale` plots a ratio probe per million (see RATE_SCALE). */
export function ProbeChart({
  probe,
  period,
  label,
  formatValue,
  scale = 1,
}: {
  probe: ProbeKey;
  period: Period;
  label: string;
  formatValue: (value: number) => string;
  scale?: number;
}) {
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.overview.history.queryOptions({ probe, period }));
  if (query.isError) return <LoadError />;
  const data = query.data;
  if (!data) return <ChartSkeleton />;
  if (data.points.length === 0) return <Empty />;
  const formatDay = (iso: string) =>
    data.bucketSeconds < 3_600
      ? formatHourMinute(iso, locale)
      : data.bucketSeconds < 86_400
        ? formatDayTime(iso, locale)
        : formatDayUtc(iso.slice(0, 10), locale);
  return (
    <LineChart
      days={data.points.map((p) => new Date(p.t).toISOString())}
      height={CHART_HEIGHT}
      series={[
        {
          key: probe,
          label,
          color: "var(--ms-steel)",
          values: data.points.map((p) => (p.value ?? 0) * scale),
          area: true,
        },
      ]}
      formatDay={formatDay}
      formatValue={(v) => formatValue(v / scale)}
    />
  );
}

/** Teams as a running count: the teams before the window plus each day's sign-ups. */
export function TeamsChart({ period, label }: { period: Period; label: string }) {
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.overview.teamsHistory.queryOptions({ period }));
  if (query.isError) return <LoadError />;
  const data = query.data;
  if (!data) return <ChartSkeleton />;
  const fmt = new Intl.NumberFormat(locale);
  const perDay = new Map(data.rows.map((r) => [r.day, r.n]));
  let running = data.before;
  const days = periodDayKeys(period);
  const values = days.map((day) => {
    running += perDay.get(day) ?? 0;
    return running;
  });
  return (
    <LineChart
      days={days}
      height={CHART_HEIGHT}
      series={[{ key: "teams", label, color: "var(--ms-steel)", values, area: true }]}
      formatDay={(day) => formatDayUtc(day, locale)}
      formatValue={(v) => fmt.format(v)}
    />
  );
}
