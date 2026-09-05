"use client";

import { WARN_BOUNCE_RATE, WARN_COMPLAINT_RATE } from "@millionsend/core/deliverability";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ChartTip, LineChart } from "@/components/line-chart";
import { Odometer } from "@/components/odometer";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { CircleInfoGlyph } from "@/components/tooltip";
import { codeRichTags } from "@/lib/code-rich-tags";
import { formatDayUtc } from "@/lib/format";
import { BAND_TONE, formatScoreTenths } from "@/lib/score-band";
import { useTRPC } from "@/lib/trpc";
import { useUrlState } from "@/lib/url-state";
import { ScoreDetailsDrawer } from "./score-details";

const RANGES = [7, 15, 30] as const;
type Range = (typeof RANGES)[number];

/**
 * Rate-card geometry from the canvas: 120px bar area, dashed RISK line at a
 * fixed top offset — bars scale so the threshold rate lands exactly on the
 * line (bounce line at top 6px → 114px = 4%; complaint at 14px → 106px = 0.01%).
 */
const BAR_AREA = 120;
const BAR_GAP = 4;
const BOUNCE = { threshold: WARN_BOUNCE_RATE, lineTop: 6 };
const COMPLAINT = { threshold: WARN_COMPLAINT_RATE, lineTop: 14 };

/**
 * Daily series on the main chart, in tooltip order. Sent is the muted
 * baseline; delivered carries the one area fill; clicked takes the violet
 * clicked hue (the info family's second step) so it separates from opened.
 */
const CHART_SERIES = [
  { key: "sent", color: "var(--ms-muted)" },
  { key: "delivered", color: "var(--ms-success)", area: true },
  { key: "opened", color: "var(--ms-info)" },
  { key: "clicked", color: "var(--ms-dot-clicked)" },
  { key: "bounced", color: "var(--ms-danger)" },
  { key: "complained", color: "var(--ms-warn)" },
] as const;

type Bar = { day: string; height: number; dayLabel: string; detail: string; partial: boolean };
type DayCounts = { day: string; sent: number; hardBounced: number; complained: number };
type EngagementDay = { day: string; delivered: number; opened: number; clicked: number };

function rateBars(
  days: DayCounts[],
  count: (d: DayCounts) => number,
  geometry: { threshold: number; lineTop: number },
  fmtPct: Intl.NumberFormat,
  fmt: Intl.NumberFormat,
  locale: string,
  today: string,
): Bar[] {
  const pxPerThreshold = BAR_AREA - geometry.lineTop;
  return days.map((d) => {
    const c = count(d);
    const rate = d.sent > 0 ? c / d.sent : 0;
    return {
      day: d.day,
      height: Math.min(BAR_AREA, Math.round((rate / geometry.threshold) * pxPerThreshold)),
      dayLabel: formatDayUtc(d.day, locale),
      detail: `${fmtPct.format(rate)} · ${fmt.format(c)}`,
      partial: d.day === today,
    };
  });
}

/**
 * Engagement has no risk threshold (higher is better), so bars scale to the
 * window's own peak rate instead of a fixed line. Rate is against delivered —
 * a message must land before it can be opened or clicked.
 */
function engagementBars(
  days: EngagementDay[],
  count: (d: EngagementDay) => number,
  fmtPct: Intl.NumberFormat,
  fmt: Intl.NumberFormat,
  locale: string,
  today: string,
): Bar[] {
  const rates = days.map((d) => (d.delivered > 0 ? count(d) / d.delivered : 0));
  const max = Math.max(0, ...rates);
  return days.map((d, i) => {
    const rate = rates[i] ?? 0;
    return {
      day: d.day,
      height: max > 0 ? Math.round((rate / max) * BAR_AREA) : 0,
      dayLabel: formatDayUtc(d.day, locale),
      detail: `${fmtPct.format(rate)} · ${fmt.format(count(d))}`,
      partial: d.day === today,
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
  color: string;
  bars: Bar[];
  rowLabel: string;
  rowCount: string;
  rowPct: string;
  // Bounce/complaint: dashed danger line the bars are scaled against.
  risk?: { label: string; lineTop: number };
  // Engagement: neutral denominator note (no threshold — higher is better).
  note?: string;
  // Tooltip suffix for a bar whose day is still being counted.
  partialNote: string;
  // Muted second footer row for what deliberately stays out of the headline.
  secondary?: { label: string; note: string; hint: string; count: string; pct: string } | undefined;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const hoveredBar = hover ? props.bars[hover.index] : undefined;

  // Same mechanics as the line chart: track the pointer over the whole bar
  // area (a thin bar is no hit target) and snap to the nearest bar's pitch —
  // bars flex to fill the card, so the pitch comes from the measured width.
  function track(event: React.PointerEvent<HTMLDivElement>) {
    if (props.bars.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const pitch = rect.width / props.bars.length;
    const index = Math.min(props.bars.length - 1, Math.max(0, Math.floor(x / pitch)));
    setHover({ index, x, y: event.clientY - rect.top });
  }

  return (
    <div className="ms-kpi-card" style={{ flex: 1 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div className="ms-microlabel">{props.label}</div>
        {props.note ? (
          <span className="ms-mono" style={{ fontSize: 10, color: "var(--ms-faint)" }}>
            {props.note}
          </span>
        ) : null}
      </div>
      <div
        className="ms-digits"
        style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1, marginTop: 6 }}
      >
        {props.headline}
      </div>
      <div
        ref={areaRef}
        style={{ position: "relative", marginTop: 16, touchAction: "pan-y" }}
        onPointerMove={track}
        onPointerDown={track}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        {hover ? (
          // Hovered-day column band (mirrors the line chart's): percent-based
          // so it needs no measurement; the bars row is positioned to paint
          // above it.
          <span
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${(hover.index / props.bars.length) * 100}%`,
              width: `${100 / props.bars.length}%`,
              background: "var(--ms-panel-raised)",
            }}
          />
        ) : null}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "flex-end",
            gap: BAR_GAP,
            height: BAR_AREA,
          }}
        >
          {props.bars.map((bar, index) => (
            <span
              key={bar.day}
              style={{
                // Bars share the row evenly so the window always spans the
                // card end-to-end, whatever the day count.
                flex: "1 1 0",
                // 2px floor keeps zero days visible as a baseline stub.
                height: Math.max(2, bar.height),
                background: props.color,
                // A day still being counted sits lighter than the settled ones.
                opacity: bar.partial
                  ? hover?.index === index
                    ? 0.55
                    : 0.4
                  : hover?.index === index
                    ? 1
                    : 0.85,
                borderRadius: 1,
              }}
            />
          ))}
        </div>
        {hover && hoveredBar ? (
          <ChartTip
            x={hover.x}
            y={hover.y}
            width={areaRef.current?.clientWidth ?? 0}
            height={BAR_AREA}
          >
            <div className="ms-mono" style={{ fontSize: 11, color: "var(--ms-muted)" }}>
              {hoveredBar.dayLabel}
              {hoveredBar.partial ? ` · ${props.partialNote}` : ""}
            </div>
            <div
              className="ms-mono"
              style={{ fontSize: 12, color: "var(--ms-bone)", marginTop: 3 }}
            >
              {hoveredBar.detail}
            </div>
          </ChartTip>
        ) : null}
        {props.risk ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: props.risk.lineTop,
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
              {props.risk.label}
            </span>
          </div>
        ) : null}
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
      {props.secondary ? (
        <div
          title={props.secondary.hint}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: "var(--ms-muted)",
            padding: "7px 0",
            borderTop: "1px solid var(--ms-line)",
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ms-faint)" }}
          />
          {props.secondary.label}
          <span className="ms-mono" style={{ fontSize: 10, color: "var(--ms-faint)" }}>
            {props.secondary.note}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <span className="ms-digits" style={{ fontSize: 12.5, color: "var(--ms-faint)" }}>
              {props.secondary.count}
            </span>
            <span
              className="ms-digits"
              style={{ fontSize: 12.5, color: "var(--ms-muted)", marginLeft: 8 }}
            >
              {props.secondary.pct}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Mirrors the loaded page: KPI card (3 figures + bar chart), then the two
 * rate cards — same containers and type wrappers, 1lh bars for text lines
 * (the KPI figure line is 40px × 1.1 = 44px; a guessed bar height would
 * shift the cards when the numbers land).
 */
function MetricsSkeleton() {
  return (
    <>
      <div className="ms-kpi-card">
        <div className="ms-kpi-row" style={{ display: "flex", gap: 56, alignItems: "flex-start" }}>
          {[90, 110, 130].map((width) => (
            <div key={width}>
              <div className="ms-microlabel" style={{ display: "flex" }}>
                <Skeleton width={width} height="1lh" />
              </div>
              <div
                className="ms-digits"
                style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1, display: "flex" }}
              >
                <Skeleton width={100} height="1lh" />
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18, display: "flex" }}>
          <Skeleton width="100%" height={228} radius="var(--ms-r-input)" />
        </div>
      </div>
      {[0, 1].map((row) => (
        <div key={row} className="ms-card-row" style={{ display: "flex", gap: 18, marginTop: 18 }}>
          {[0, 1].map((card) => (
            <div key={card} className="ms-kpi-card" style={{ flex: 1 }}>
              <div className="ms-microlabel" style={{ display: "flex" }}>
                <Skeleton width={110} height="1lh" />
              </div>
              <div
                className="ms-digits"
                style={{
                  fontSize: "var(--ms-fs-kpi)",
                  lineHeight: 1.1,
                  marginTop: 6,
                  display: "flex",
                }}
              >
                <Skeleton width={80} height="1lh" />
              </div>
              <div style={{ marginTop: 16, display: "flex" }}>
                <Skeleton width="100%" height={BAR_AREA} radius="var(--ms-r-input)" />
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  fontSize: 13,
                  padding: "7px 0",
                  borderTop: "1px solid var(--ms-line)",
                  marginTop: 12,
                }}
              >
                <Skeleton width={120} height="1lh" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** Mirrors the loaded score card: label row, hero digits line, 4-column footer. */
function AccountScoreSkeleton() {
  return (
    <div className="ms-kpi-card" style={{ marginTop: 18 }}>
      <div className="ms-microlabel" style={{ display: "flex" }}>
        <Skeleton width={110} height="1lh" />
      </div>
      <div
        className="ms-digits"
        style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1, marginTop: 6, display: "flex" }}
      >
        <Skeleton width={110} height="1lh" />
      </div>
      <div
        className="ms-kpi-row"
        style={{
          display: "flex",
          gap: 56,
          marginTop: 16,
          paddingTop: 14,
          borderTop: "1px solid var(--ms-line)",
          alignItems: "flex-start",
        }}
      >
        {[0, 1, 2, 3].map((column) => (
          <div key={column}>
            <div className="ms-microlabel" style={{ display: "flex" }}>
              <Skeleton width={80} height="1lh" />
            </div>
            <div className="ms-digits" style={{ fontSize: 20, marginTop: 4, display: "flex" }}>
              <Skeleton width={44} height="1lh" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const t = useTranslations("metrics");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const [rangeParam, setRangeParam] = useUrlState("range", "15");
  // URL input — anything but a known range key falls back to the default.
  const days: Range = RANGES.find((r) => String(r) === rangeParam) ?? 15;
  const query = useQuery(trpc.metrics.window.queryOptions({ days }));
  const scoreQuery = useQuery(trpc.metrics.accountScore.queryOptions());
  const [scoreDetailsOpen, setScoreDetailsOpen] = useState(false);
  // Same glyph and trigger as the DNS tables' tooltip; here it opens the drawer.
  const detailsGlyph = (
    <button
      type="button"
      className="ms-tooltip-trigger"
      aria-label={t("score.details.title")}
      onClick={() => setScoreDetailsOpen(true)}
    >
      <CircleInfoGlyph />
    </button>
  );

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

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <Select
            value={String(days)}
            onChange={setRangeParam}
            ariaLabel={t(`range.${days}`)}
            options={RANGES.map((r) => ({ value: String(r), label: t(`range.${r}`) }))}
          />
        }
      />

      {data === undefined ? (
        <MetricsSkeleton />
      ) : neverSent ? (
        <EmptyState area="metrics" headline={t("empty")} body={t.rich("emptyHint", codeRichTags)} />
      ) : (
        <>
          <div className="ms-kpi-card">
            <div
              className="ms-kpi-row"
              style={{ display: "flex", gap: 56, alignItems: "flex-start" }}
            >
              <KpiValue label={t("kpi.emails")}>
                <Odometer formatted={fmt.format(data.totals.sent)} />
              </KpiValue>
              <KpiValue label={t("kpi.deliverability")}>
                {data.totals.sent > 0 ? (
                  <Odometer formatted={pct1.format(data.totals.delivered / data.totals.sent)} />
                ) : (
                  "—"
                )}
              </KpiValue>
              <KpiValue label={t("kpi.allTimeDelivered")}>
                <Odometer formatted={fmt.format(data.allTimeDelivered)} />
              </KpiValue>
            </div>
            <div style={{ marginTop: 18 }}>
              <LineChart
                days={data.days.map((d) => d.day)}
                height={228}
                series={CHART_SERIES.map((s) => ({
                  ...s,
                  label: common(`status.${s.key}`),
                  values: data.days.map((d) => d[s.key]),
                }))}
                formatDay={(day) => formatDayUtc(day, locale)}
                formatValue={(value) => fmt.format(value)}
                partialNote={t("chart.soFar")}
              />
            </div>
          </div>

          {scoreQuery.data === undefined ? (
            <AccountScoreSkeleton />
          ) : (
            <div className="ms-kpi-card" style={{ marginTop: 18 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div className="ms-microlabel">{t("score.title")}</div>
                <span className="ms-mono" style={{ fontSize: 10, color: "var(--ms-faint)" }}>
                  {t("score.window")}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <div
                  className="ms-digits"
                  style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1, marginTop: 6 }}
                >
                  {scoreQuery.data.scoreTenths != null ? (
                    <Odometer formatted={formatScoreTenths(scoreQuery.data.scoreTenths, locale)} />
                  ) : (
                    "—"
                  )}
                </div>
                <span className="ms-digits" style={{ fontSize: 15, color: "var(--ms-muted)" }}>
                  {t("score.outOfTen")}
                </span>
                {scoreQuery.data.band ? (
                  <span className={`ms-badge ms-badge-${BAND_TONE[scoreQuery.data.band]}`}>
                    {common(`band.${scoreQuery.data.band}`)}
                  </span>
                ) : null}
                {scoreQuery.data.guardrailStatus !== "ok" ? (
                  <span style={{ fontSize: 12.5, color: "var(--ms-warn)" }}>
                    {t("score.capped")}
                  </span>
                ) : null}
              </div>
              <div
                className="ms-kpi-row"
                style={{
                  display: "flex",
                  gap: 56,
                  marginTop: 16,
                  paddingTop: 14,
                  borderTop: "1px solid var(--ms-line)",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div
                    className="ms-microlabel"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    {t("score.content")}
                    {detailsGlyph}
                  </div>
                  <div className="ms-digits" style={{ fontSize: 20, marginTop: 4 }}>
                    {scoreQuery.data.contentScoreTenths != null
                      ? formatScoreTenths(scoreQuery.data.contentScoreTenths, locale)
                      : "—"}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ms-faint)", marginTop: 3 }}>
                    {t("score.contentLine")}
                  </div>
                </div>
                <div>
                  <div
                    className="ms-microlabel"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    {t("score.outcome")}
                    {detailsGlyph}
                  </div>
                  <div className="ms-digits" style={{ fontSize: 20, marginTop: 4 }}>
                    {scoreQuery.data.outcomeScoreTenths != null
                      ? formatScoreTenths(scoreQuery.data.outcomeScoreTenths, locale)
                      : "—"}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ms-faint)", marginTop: 3 }}>
                    {scoreQuery.data.insufficientOutcomeData
                      ? t("score.insufficient")
                      : t("score.outcomeLine")}
                  </div>
                </div>
                <div>
                  <div className="ms-microlabel">{t("score.complaintRate")}</div>
                  <div className="ms-digits" style={{ fontSize: 20, marginTop: 4 }}>
                    {pct2.format(scoreQuery.data.complaintRate)}
                  </div>
                </div>
                <div>
                  <div className="ms-microlabel">{t("score.hardBounceRate")}</div>
                  <div className="ms-digits" style={{ fontSize: 20, marginTop: 4 }}>
                    {pct2.format(scoreQuery.data.hardBounceRate)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setScoreDetailsOpen(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                  marginTop: 16,
                  paddingTop: 12,
                  border: 0,
                  borderTop: "1px solid var(--ms-line)",
                  background: "none",
                  color: "var(--ms-muted)",
                  font: "inherit",
                  fontSize: "var(--ms-fs-label)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span>{t("score.details.open")}</span>
                <span style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>→</span>
              </button>
              <ScoreDetailsDrawer
                open={scoreDetailsOpen}
                onClose={() => setScoreDetailsOpen(false)}
              />
            </div>
          )}

          <div className="ms-card-row" style={{ display: "flex", gap: 18, marginTop: 18 }}>
            <RateCard
              label={t("bounce.title")}
              headline={
                data.totals.sent > 0 ? pct1.format(data.totals.hardBounced / data.totals.sent) : "—"
              }
              risk={{ label: t("bounce.risk"), lineTop: BOUNCE.lineTop }}
              color="var(--ms-danger)"
              partialNote={t("chart.soFar")}
              bars={rateBars(
                data.days,
                (d) => d.hardBounced,
                BOUNCE,
                pct2,
                fmt,
                locale,
                data.today,
              )}
              rowLabel={t("bounce.bounced")}
              rowCount={fmt.format(data.totals.hardBounced)}
              rowPct={
                data.totals.sent > 0 ? pct2.format(data.totals.hardBounced / data.totals.sent) : "—"
              }
            />
            <RateCard
              label={t("complaint.title")}
              headline={
                data.totals.sent > 0 ? pct2.format(data.totals.complained / data.totals.sent) : "—"
              }
              risk={{ label: t("complaint.risk"), lineTop: COMPLAINT.lineTop }}
              color="var(--ms-warn)"
              partialNote={t("chart.soFar")}
              bars={rateBars(
                data.days,
                (d) => d.complained,
                COMPLAINT,
                pct2,
                fmt,
                locale,
                data.today,
              )}
              rowLabel={t("complaint.complained")}
              rowCount={fmt.format(data.totals.complained)}
              rowPct={
                data.totals.sent > 0 ? pct2.format(data.totals.complained / data.totals.sent) : "—"
              }
            />
          </div>

          <div className="ms-card-row" style={{ display: "flex", gap: 18, marginTop: 18 }}>
            <RateCard
              label={t("open.title")}
              note={t("engagement.denominator")}
              headline={
                data.totals.delivered > 0
                  ? pct1.format(data.totals.opened / data.totals.delivered)
                  : "—"
              }
              color="var(--ms-info)"
              partialNote={t("chart.soFar")}
              bars={engagementBars(data.days, (d) => d.opened, pct1, fmt, locale, data.today)}
              rowLabel={t("open.opened")}
              secondary={
                data.totals.prefetched > 0
                  ? {
                      label: t("open.prefetched"),
                      note: t("open.notCounted"),
                      hint: t("open.prefetchedHint"),
                      count: fmt.format(data.totals.prefetched),
                      pct:
                        data.totals.delivered > 0
                          ? pct1.format(data.totals.prefetched / data.totals.delivered)
                          : "—",
                    }
                  : undefined
              }
              rowCount={fmt.format(data.totals.opened)}
              rowPct={
                data.totals.delivered > 0
                  ? pct1.format(data.totals.opened / data.totals.delivered)
                  : "—"
              }
            />
            <RateCard
              label={t("click.title")}
              note={t("engagement.denominator")}
              headline={
                data.totals.delivered > 0
                  ? pct1.format(data.totals.clicked / data.totals.delivered)
                  : "—"
              }
              color="var(--ms-info)"
              partialNote={t("chart.soFar")}
              bars={engagementBars(data.days, (d) => d.clicked, pct1, fmt, locale, data.today)}
              rowLabel={t("click.clicked")}
              rowCount={fmt.format(data.totals.clicked)}
              rowPct={
                data.totals.delivered > 0
                  ? pct1.format(data.totals.clicked / data.totals.delivered)
                  : "—"
              }
            />
          </div>
        </>
      )}
    </>
  );
}
