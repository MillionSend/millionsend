import { describe, expect, it } from "vitest";
import { axisLabels } from "./chart-axis";

const plot = { start: 0, end: 300 };
const evenly = (count: number) => (i: number) => (i * plot.end) / (count - 1);

describe("axisLabels", () => {
  it("keeps every step-th label from the newest, anchoring the edge ones inward", () => {
    expect(axisLabels(7, 2, evenly(7), () => 40, plot)).toEqual([
      { index: 6, x: 300, anchor: "end" },
      { index: 4, x: 200, anchor: "middle" },
      { index: 2, x: 100, anchor: "middle" },
      { index: 0, x: 0, anchor: "start" },
    ]);
  });

  it("drops labels that would touch a neighbour once the edge ones are anchored inward", () => {
    // 8 would run into the end-anchored 10, and 0, anchored to the start, into 2.
    const labels = axisLabels(11, 2, evenly(11), () => 50, plot);
    expect(labels.map((l) => l.index)).toEqual([10, 6, 4, 2]);
  });

  it("centres a lone point's label", () => {
    expect(
      axisLabels(
        1,
        1,
        () => 150,
        () => 40,
        plot,
      ),
    ).toEqual([{ index: 0, x: 150, anchor: "middle" }]);
  });
});
