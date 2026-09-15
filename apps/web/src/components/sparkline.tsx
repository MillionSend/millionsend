"use client";

import { useState } from "react";
import { ChartTip } from "./line-chart";

/**
 * A bleed sparkline: no axes, stretches to its container, a faint area under
 * the line, and a pointer-tracked tooltip snapped to the nearest point (same
 * mechanics as the growth sparkline). Sized by its container; `height` is the
 * drawn height.
 */
export function Sparkline({
  values,
  labels,
  formatValue,
  color = "var(--ms-steel)",
  height = 56,
  min,
  max,
}: {
  values: number[];
  /** One label per value, for the tooltip. */
  labels: string[];
  formatValue: (value: number) => string;
  color?: string;
  height?: number;
  /** Floor of the y axis; the series minimum when omitted. */
  min?: number;
  /** Ceiling of the y axis, for small multiples that share one scale; the series peak when omitted. */
  max?: number;
}) {
  const [hover, setHover] = useState<{ index: number; px: number; py: number; w: number } | null>(
    null,
  );
  const W = 300;
  const n = values.length;
  const top = (max ?? Math.max(...values, 0)) * 1.05 || 1;
  const floor = min ?? Math.min(...values, 0) * 0.9;
  const span = top - floor || 1;
  const x = (i: number) => (n <= 1 ? W : (i / (n - 1)) * W);
  const y = (v: number) => 8 + (1 - (v - floor) / span) * (height - 8);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  if (n === 1) points.unshift(`0,${y(values[0] ?? 0).toFixed(1)}`);
  const line = points.join(" ");
  const area = `M${points[0]} L${points.slice(1).join(" L")} L${W},${height} L0,${height} Z`;

  function track(event: React.PointerEvent<HTMLDivElement>) {
    if (n === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const index = Math.min(n - 1, Math.max(0, Math.round((px / rect.width) * (n - 1))));
    setHover({ index, px, py: event.clientY - rect.top, w: rect.width });
  }
  const hovered = hover ? values[hover.index] : undefined;

  return (
    <div
      style={{ position: "relative", width: "100%", height, touchAction: "pan-y" }}
      onPointerMove={track}
      onPointerDown={track}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setHover(null)}
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        {n > 0 ? (
          <>
            <path d={area} fill={color} opacity={0.12} />
            <polyline
              points={line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
        {hover ? (
          <line
            x1={x(hover.index)}
            x2={x(hover.index)}
            y1={0}
            y2={height}
            stroke="var(--ms-line-strong)"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {hover && hovered !== undefined ? (
        <ChartTip x={hover.px} y={hover.py} width={hover.w} height={height}>
          <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-muted)" }}>
            {labels[hover.index]}
          </span>
          <span
            className="ms-mono"
            style={{ marginLeft: 10, fontSize: 12, color: "var(--ms-bone)" }}
          >
            {formatValue(hovered)}
          </span>
        </ChartTip>
      ) : null}
    </div>
  );
}
