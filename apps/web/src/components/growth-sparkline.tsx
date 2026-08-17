/**
 * Audience growth sparkline: cumulative subscribers as a filled area
 * (success tone) with cumulative unsubscribes as a thin line (danger tone)
 * along the bottom — the Resend METRICS block, on our tokens. Pure SVG.
 */

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
    return { total, out };
  });
}

export function GrowthSparkline({
  added,
  unsubscribed,
  width = 200,
  height = 52,
}: {
  added: DayCount[];
  unsubscribed: DayCount[];
  width?: number;
  height?: number;
}) {
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

  return (
    <svg width={width} height={height} aria-hidden="true">
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
    </svg>
  );
}
