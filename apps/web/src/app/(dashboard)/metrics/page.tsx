"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Odometer } from "@/components/odometer";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { codeRichTags } from "@/lib/code-rich-tags";
import { useTRPC } from "@/lib/trpc";

const RANGES = [7, 15, 30] as const;
type Range = (typeof RANGES)[number];

/**
 * Rate-card geometry from the canvas: 120px bar area, dashed RISK line at a
 * fixed top offset — bars scale so the threshold rate lands exactly on the
 * line (bounce line at top 6px → 114px = 4%; complaint at 14px → 106px = 0.08%).
 */
const BAR_AREA = 120;
const BOUNCE = { threshold: 0.04, lineTop: 6 };
const COMPLAINT = { threshold: 0.0008, lineTop: 14 };

type Bar = { day: string; height: number; title: string };
type DayCounts = { day: string; sent: number; bounced: number; complained: number };

function rateBars(
  days: DayCounts[],
  count: (d: DayCounts) => number,
  geometry: { threshold: number; lineTop: number },
  fmtPct: Intl.NumberFormat,
): Bar[] {
  const pxPerThreshold = BAR_AREA - geometry.lineTop;
  return days.map((d) => {
    const rate = d.sent > 0 ? count(d) / d.sent : 0;
    return {
      day: d.day,
      height: Math.min(BAR_AREA, Math.round((rate / geometry.threshold) * pxPerThreshold)),
      title: `${d.day} · ${fmtPct.format(rate)}`,
    };
  });
}

function KpiValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="ms-microlabel">{label}</div>
      <div className="ms-digits" style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1 }}>
        {children}
      </div>
    </div>
  );
}

function RateCard(props: {
  label: string;
  headline: string;
  riskLabel: string;
  lineTop: number;
  color: string;
  bars: Bar[];
  rowLabel: string;
  rowCount: string;
  rowPct: string;
}) {
  return (
    <div className="ms-kpi-card" style={{ flex: 1 }}>
      <div className="ms-microlabel">{props.label}</div>
      <div
        className="ms-digits"
        style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1, marginTop: 6 }}
      >
        {props.headline}
      </div>
      <div style={{ position: "relative", marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: BAR_AREA }}>
          {props.bars.map((bar) => (
            <span
              key={bar.day}
              title={bar.title}
              style={{
                width: 4,
                height: bar.height,
                background: props.color,
                opacity: 0.85,
                borderRadius: 1,
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: props.lineTop,
            borderTop: "1px dashed var(--ms-danger)",
          }}
        >
          <span
            className="ms-mono"
            style={{
              position: "absolute",
              right: 0,
              top: -16,
              fontSize: 10,
              color: "var(--ms-danger)",
            }}
          >
            {props.riskLabel}
          </span>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: "var(--ms-muted)",
          padding: "7px 0",
          borderTop: "1px solid var(--ms-line)",
          marginTop: 12,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: props.color }} />
        {props.rowLabel}
        <span style={{ marginLeft: "auto" }}>
          <span className="ms-digits" style={{ fontSize: 12.5, color: "var(--ms-faint)" }}>
            {props.rowCount}
          </span>
          <span
            className="ms-digits"
            style={{ fontSize: 12.5, color: "var(--ms-bone)", marginLeft: 8 }}
          >
            {props.rowPct}
          </span>
        </span>
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const t = useTranslations("metrics");
  const locale = useLocale();
  const trpc = useTRPC();
  const [days, setDays] = useState<Range>(15);
  const query = useQuery(trpc.metrics.window.queryOptions({ days }));

  const fmt = new Intl.NumberFormat(locale);
  const pct1 = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const pct2 = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const data = query.data;
  const neverSent =
    data !== undefined &&
    data.allTimeDelivered === 0 &&
    data.totals.accepted === 0 &&
    data.totals.sent === 0;

  const maxSent = data ? Math.max(...data.days.map((d) => d.sent)) : 0;

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <Select
            value={String(days)}
            onChange={(value) => setDays(Number(value) as Range)}
            ariaLabel={t(`range.${days}`)}
            options={RANGES.map((r) => ({ value: String(r), label: t(`range.${r}`) }))}
          />
        }
      />

      {data === undefined ? (
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>{t("loading")}</p>
      ) : neverSent ? (
        <EmptyState area="metrics" headline={t("empty")} body={t.rich("emptyHint", codeRichTags)} />
      ) : (
        <>
          <div className="ms-kpi-card">
            <div
              className="ms-kpi-row"
              style={{ display: "flex", gap: 56, alignItems: "flex-start" }}
            >
              <KpiValue label={t("kpi.emails")}>{fmt.format(data.totals.sent)}</KpiValue>
              <KpiValue label={t("kpi.deliverability")}>
                {data.totals.sent > 0 ? pct1.format(data.totals.delivered / data.totals.sent) : "—"}
              </KpiValue>
              <KpiValue label={t("kpi.allTimeDelivered")}>
                <Odometer formatted={fmt.format(data.allTimeDelivered)} />
              </KpiValue>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 4,
                height: 228,
                marginTop: 18,
              }}
            >
              {data.days.map((d) => (
                <span
                  key={d.day}
                  title={`${d.day} · ${fmt.format(d.sent)}`}
                  style={{
                    flex: 1,
                    height: maxSent > 0 ? Math.round((d.sent / maxSent) * 220) : 0,
                    background: "var(--ms-info)",
                    opacity: 0.85,
                    borderRadius: 1,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="ms-card-row" style={{ display: "flex", gap: 18, marginTop: 18 }}>
            <RateCard
              label={t("bounce.title")}
              headline={
                data.totals.sent > 0 ? pct1.format(data.totals.bounced / data.totals.sent) : "—"
              }
              riskLabel={t("bounce.risk")}
              lineTop={BOUNCE.lineTop}
              color="var(--ms-danger)"
              bars={rateBars(data.days, (d) => d.bounced, BOUNCE, pct2)}
              rowLabel={t("bounce.bounced")}
              rowCount={fmt.format(data.totals.bounced)}
              rowPct={
                data.totals.sent > 0 ? pct2.format(data.totals.bounced / data.totals.sent) : "—"
              }
            />
            <RateCard
              label={t("complaint.title")}
              headline={
                data.totals.sent > 0 ? pct2.format(data.totals.complained / data.totals.sent) : "—"
              }
              riskLabel={t("complaint.risk")}
              lineTop={COMPLAINT.lineTop}
              color="var(--ms-warn)"
              bars={rateBars(data.days, (d) => d.complained, COMPLAINT, pct2)}
              rowLabel={t("complaint.complained")}
              rowCount={fmt.format(data.totals.complained)}
              rowPct={
                data.totals.sent > 0 ? pct2.format(data.totals.complained / data.totals.sent) : "—"
              }
            />
          </div>
        </>
      )}
    </>
  );
}
