"use client";

import { useLayoutEffect, useRef, useState } from "react";

export interface LineChartSeries {
  key: string;
  label: string;
  /** CSS color — --ms-* token vars expected. */
  color: string;
  values: number[];
  /** Subtle area fill under this series (the chart's one filled band). */
  area?: boolean;
}

/* Plot frame: the left edge is full-bleed so the plot starts on the card's
   own padding; the right edge reserves a gutter sized to the widest y tick
   label so the axis never overlaps the series. */
const PAD = { top: 12, bottom: 24, left: 0 };
/* Width one short-day x label needs — drives label thinning. */
const X_LABEL_W = 46;

/** 1/2/5×10^k ceiling so gridline ticks land on round numbers. */
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / mag;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag;
}

/**
 * Floating hover panel shared by the line chart and the metrics rate bars:
 * absolutely positioned inside a position:relative container, following the
 * pointer offset by 14px and clamped inside the given bounds (flipping left
 * of the pointer when the right edge would clip). Measured after render,
 * like tooltip.tsx. pointer-events: none keeps hover tracking simple.
 */
export function ChartTip({
  x,
  y,
  width,
  height,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const flipped = x + 14 + tip.offsetWidth > width - 2;
    const left = flipped ? x - 14 - tip.offsetWidth : x + 14;
    tip.style.left = `${Math.max(2, left)}px`;
    tip.style.top = `${Math.min(Math.max(2, y + 14), Math.max(2, height - tip.offsetHeight - 2))}px`;
  });
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        zIndex: 2,
        background: "var(--ms-panel)",
        border: "1px solid var(--ms-line-strong)",
        borderRadius: 8,
        padding: "7px 10px",
        minWidth: 132,
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Multi-series daily line chart, pure SVG: straight segments, dashed
 * horizontal gridlines with right-side round-tick labels, thinned localized
 * x-axis day labels, and a pointer-tracked hover (column band snapped to
 * the nearest day, a dot per series, floating clamped tooltip). Width follows
 * the container via ResizeObserver. No transitions, so reduced-motion needs
 * no special casing.
 */
export function LineChart({
  days,
  series,
  height = 228,
  formatDay,
  formatValue,
}: {
  days: string[];
  series: LineChartSeries[];
  height?: number;
  /** Localized short-day label for the axis and tooltip (UTC-pinned). */
  formatDay: (day: string) => string;
  formatValue: (value: number) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ index: number; px: number; py: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = days.length;
  const plotH = height - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotH;

  const peak = Math.max(1, ...series.flatMap((s) => s.values));
  // Floor of 1: these are counts — a quiet window must not grow 0.5 ticks.
  const step = Math.max(1, niceStep(peak / 4));
  const top = step * Math.ceil(peak / step);
  const ticks = Array.from({ length: Math.round(top / step) }, (_, i) => (i + 1) * step);

  // Right gutter sized to the widest tick label (10px mono ≈ 6.2px/glyph).
  const gutter = Math.ceil(8 + Math.max(...ticks.map((t) => formatValue(t).length)) * 6.2);
  const plotW = width - PAD.left - gutter;
  const plotEnd = PAD.left + plotW;

  const x = (i: number) => (n <= 1 ? PAD.left + plotW / 2 : PAD.left + (i * plotW) / (n - 1));
  const y = (v: number) => PAD.top + plotH * (1 - v / top);
  const point = (i: number, v: number) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`;

  // Thin from the right so the newest day always keeps its label.
  const labelStep = Math.max(1, Math.ceil((n * X_LABEL_W) / Math.max(1, plotW)));

  function track(event: React.PointerEvent<HTMLDivElement>) {
    if (n === 0 || plotW <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const frac = n <= 1 ? 0 : (px - PAD.left) / plotW;
    const index = Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
    setHover({ index, px, py });
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", height, touchAction: "pan-y" }}
      onPointerMove={track}
      onPointerDown={track}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setHover(null)}
    >
      {width > 0 && n > 0 ? (
        <svg width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
          {hover
            ? // Hovered-day column band, drawn first so gridlines and series
              // stay legible over it. One day-pitch wide, clamped to the plot.
              (() => {
                const pitch = n <= 1 ? plotW : plotW / (n - 1);
                const left = Math.max(0, x(hover.index) - pitch / 2);
                return (
                  <rect
                    x={left}
                    y={0}
                    width={Math.min(plotEnd - left, pitch)}
                    height={baseline}
                    fill="var(--ms-panel-raised)"
                  />
                );
              })()
            : null}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={plotEnd}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--ms-line)"
                strokeDasharray="3 4"
              />
              <text
                x={width}
                y={y(tick) + 3}
                fontSize={10}
                fontFamily="var(--ms-font-mono)"
                fill="var(--ms-faint)"
                textAnchor="end"
              >
                {formatValue(tick)}
              </text>
            </g>
          ))}
          <line
            x1={PAD.left}
            x2={plotEnd}
            y1={baseline}
            y2={baseline}
            stroke="var(--ms-line-strong)"
          />
          {days.map((day, i) =>
            (n - 1 - i) % labelStep === 0 ? (
              <text
                key={day}
                x={x(i)}
                y={height - 6}
                fontSize={10}
                fontFamily="var(--ms-font-mono)"
                fill="var(--ms-faint)"
                // Edge labels anchor inward so the full-bleed plot never
                // clips them at the card padding.
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              >
                {formatDay(day)}
              </text>
            ) : null,
          )}
          {series.map((s) =>
            s.area ? (
              <path
                key={`${s.key}-area`}
                d={`M${s.values.map((v, i) => point(i, v)).join(" L")} L${x(n - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`}
                fill={`color-mix(in srgb, ${s.color} 13%, transparent)`}
              />
            ) : null,
          )}
          {series.map((s) => (
            <polyline
              key={s.key}
              points={s.values.map((v, i) => point(i, v)).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ))}
          {hover
            ? series.map((s) => (
                <circle
                  key={`${s.key}-dot`}
                  cx={x(hover.index)}
                  cy={y(s.values[hover.index] ?? 0)}
                  r={3}
                  fill={s.color}
                  stroke="var(--ms-panel)"
                  strokeWidth={1.5}
                />
              ))
            : null}
        </svg>
      ) : null}
      {hover ? (
        <ChartTip x={hover.px} y={hover.py} width={width} height={height}>
          <div
            className="ms-mono"
            style={{ fontSize: 11, color: "var(--ms-muted)", marginBottom: 4 }}
          >
            {formatDay(days[hover.index] ?? "")}
          </div>
          {series.map((s) => (
            <div
              key={s.key}
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
                  background: s.color,
                  flex: "none",
                }}
              />
              <span style={{ color: "var(--ms-muted)" }}>{s.label}</span>
              <span className="ms-mono" style={{ marginLeft: "auto", color: "var(--ms-bone)" }}>
                {formatValue(s.values[hover.index] ?? 0)}
              </span>
            </div>
          ))}
        </ChartTip>
      ) : null}
    </div>
  );
}
