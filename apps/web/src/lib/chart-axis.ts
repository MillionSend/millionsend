export type AxisAnchor = "start" | "middle" | "end";

/**
 * Which x-axis labels a chart prints, and where. Every `step`-th label is
 * kept counting back from the newest, so the latest point is always labelled;
 * each is centred on its point, or anchored inward when centring would cross
 * the plot's edge. A label that would touch the one kept to its right is
 * dropped instead of overlapping it. `width` estimates a label's printed width.
 */
export function axisLabels(
  count: number,
  step: number,
  at: (index: number) => number,
  width: (index: number) => number,
  plot: { start: number; end: number },
  gap = 6,
): { index: number; x: number; anchor: AxisAnchor }[] {
  const out: { index: number; x: number; anchor: AxisAnchor }[] = [];
  let taken = Number.POSITIVE_INFINITY;
  for (let index = count - 1; index >= 0; index -= Math.max(1, step)) {
    const w = width(index);
    const centre = at(index);
    const anchor: AxisAnchor =
      centre + w / 2 > plot.end ? "end" : centre - w / 2 < plot.start ? "start" : "middle";
    const x = anchor === "end" ? plot.end : anchor === "start" ? plot.start : centre;
    const left = anchor === "end" ? x - w : anchor === "start" ? x : x - w / 2;
    if (left + w + gap > taken) continue;
    out.push({ index, x, anchor });
    taken = left;
  }
  return out;
}
