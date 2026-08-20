"use client";

/**
 * Audience growth sparkline: cumulative subscribers as a filled area
 * (success tone) with cumulative unsubscribes as a thin line (danger tone)
 * along the bottom — the Resend METRICS block, on our tokens. Pure SVG,
 * with a pointer-tracked hover snapped to the nearest day (ChartTip, same
 * mechanics as the metrics line chart).
 */

import { useState } from "react";
import { ChartTip } from "./line-chart";

interface DayCount {
  day: string;
  count: number;
}

/** Cumulative value per day across the union of both series' day axes. */
function buildSeries(added: DayCount[], unsubscribed: DayCount[]) {
  const days = [...new Set([...added, ...unsubscribed].map((d) => d.day))].sort();
  const addedBy = new Map(added.map((d) => [d.day, d.count]));
  const unsubBy = new Map(unsubscribed.map((d) => [d.day, d.count]));
  let total = 0;
  let out = 0;
  return days.map((day) => {
    total += addedBy.get(day) ?? 0;
    out += unsubBy.get(day) ?? 0;
    return { day, total, out };
  });
}

export function GrowthSparkline({
  added,
  unsubscribed,
  totalLabel,
  outLabel,
  formatDay,
  formatValue,
  width = 200,
  height = 52,
}: {
  added: DayCount[];
  unsubscribed: DayCount[];
  totalLabel: string;
  outLabel: string;
  /** Localized short-day label for the tooltip (UTC-pinned). */
  formatDay: (day: string) => string;
  formatValue: (value: number) => string;
  width?: number;
  height?: number;
}) {
  const [hover, setHover] = useState<{ index: number; px: number; py: number } | null>(null);
  const series = buildSeries(added, unsubscribed);
  if (series.length === 0) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1="0"
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="var(--ms-line-strong)"
          strokeDasharray="3 4"
        />
      </svg>
    );
  }

  const max = Math.max(series[series.length - 1]?.total ?? 1, 1);
  const pad = 2;
  const x = (i: number) =>
    series.length === 1 ? width - pad : pad + (i * (width - pad * 2)) / (series.length - 1);
  const y = (v: number) => height - pad - (v * (height - pad * 2)) / max;

  const totalPoints = series.map((s, i) => `${x(i).toFixed(1)},${y(s.total).toFixed(1)}`);
  const outPoints = series.map((s, i) => `${x(i).toFixed(1)},${y(s.out).toFixed(1)}`);
  // A single day still draws: extend a flat segment from the left edge.
  if (series.length === 1) {
    totalPoints.unshift(`${pad},${y(series[0]?.total ?? 0).toFixed(1)}`);
    outPoints.unshift(`${pad},${y(series[0]?.out ?? 0).toFixed(1)}`);
  }

  const area = `M${totalPoints[0]} L${totalPoints.slice(1).join(" L")} L${(width - pad).toFixed(1)},${height - pad} L${pad},${height - pad} Z`;

  function track(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const frac = series.length <= 1 ? 1 : (px - pad) / (width - pad * 2);
    const index = Math.min(series.length - 1, Math.max(0, Math.round(frac * (series.length - 1))));
    setHover({ index, px, py });
  }

  const hovered = hover ? series[hover.index] : undefined;

  return (
    <div
      style={{ position: "relative", width, height, touchAction: "pan-y" }}
      onPointerMove={track}
      onPointerDown={track}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setHover(null)}
    >
      <svg width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
        <path d={area} fill="color-mix(in srgb, var(--ms-success) 22%, transparent)" />
        <polyline
          points={totalPoints.join(" ")}
          fill="none"
          stroke="var(--ms-success)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <polyline
          points={outPoints.join(" ")}
          fill="none"
          stroke="var(--ms-danger)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {hover && hovered ? (
          <>
            <line
              x1={x(hover.index)}
              x2={x(hover.index)}
              y1={0}
              y2={height}
              stroke="var(--ms-line-strong)"
            />
            <circle
              cx={x(hover.index)}
              cy={y(hovered.total)}
              r={2.5}
              fill="var(--ms-success)"
              stroke="var(--ms-panel)"
              strokeWidth={1.5}
            />
            <circle
              cx={x(hover.index)}
              cy={y(hovered.out)}
              r={2.5}
              fill="var(--ms-danger)"
              stroke="var(--ms-panel)"
              strokeWidth={1.5}
            />
          </>
        ) : null}
      </svg>
      {hover && hovered ? (
        <ChartTip x={hover.px} y={hover.py} width={width} height={height}>
          <div
            className="ms-mono"
            style={{ fontSize: 11, color: "var(--ms-muted)", marginBottom: 4 }}
          >
            {formatDay(hovered.day)}
          </div>
          {(
            [
              { label: totalLabel, color: "var(--ms-success)", value: hovered.total },
              { label: outLabel, color: "var(--ms-danger)", value: hovered.out },
            ] as const
          ).map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 12,
                lineHeight: 1.8,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: row.color,
                  flex: "none",
                }}
              />
              <span style={{ color: "var(--ms-muted)" }}>{row.label}</span>
              <span className="ms-mono" style={{ marginLeft: "auto", color: "var(--ms-bone)" }}>
                {formatValue(row.value)}
              </span>
            </div>
          ))}
        </ChartTip>
      ) : null}
    </div>
  );
}
