import { describe, expect, it } from "vitest";
import { clampInto, placeChartTip, placePanel, trackedPointer } from "./panel-placement";

const phone = { width: 390, height: 844 };
const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("clampInto", () => {
  it("leaves a span that fits alone and pulls one that overhangs back inside the margin", () => {
    expect(clampInto(100, 50, 390)).toBe(100);
    expect(clampInto(-134, 180, 390)).toBe(12);
    expect(clampInto(300, 180, 390)).toBe(198);
  });

  it("starts a span longer than the room at the margin", () => {
    expect(clampInto(40, 500, 390)).toBe(12);
  });
});

describe("placePanel", () => {
  it("hangs a menu below its trigger, start-aligned, when there is room", () => {
    expect(placePanel(box(20, 100, 120, 30), { width: 200, height: 150 }, phone)).toEqual({
      left: 20,
      top: 136,
      bottom: 844 - 136 - 150,
      maxHeight: 844 - 130 - 6 - 12,
      above: false,
    });
  });

  it("hangs an end-aligned menu from the trigger's start when its trigger sits at the left edge", () => {
    const placed = placePanel(box(16, 300, 30, 30), { width: 180, height: 120 }, phone, {
      align: "end",
    });
    expect(placed.left).toBe(16);
  });

  it("hangs a start-aligned list from the trigger's end when its trigger sits at the right edge", () => {
    const placed = placePanel(box(250, 300, 120, 30), { width: 200, height: 120 }, phone);
    expect(placed.left).toBe(170);
  });

  it("shifts a panel that fits from neither edge of its trigger inside the margin", () => {
    const placed = placePanel(box(100, 300, 30, 30), { width: 300, height: 120 }, phone, {
      align: "end",
    });
    expect(placed.left).toBe(12);
  });

  it("keeps an end-aligned menu flush with its trigger when that fits", () => {
    const placed = placePanel(box(344, 300, 30, 30), { width: 180, height: 120 }, phone, {
      align: "end",
    });
    expect(placed.left).toBe(194);
  });

  it("caps a centred tooltip wider than the viewport and starts it at the margin", () => {
    const placed = placePanel(box(180, 400, 14, 14), { width: 420, height: 60 }, phone, {
      align: "center",
      prefer: "above",
      gap: 8,
    });
    expect(placed).toMatchObject({ left: 12, top: 400 - 8 - 60, above: true });
  });

  it("flips a panel above when it does not fit below and above has more room", () => {
    const placed = placePanel(box(20, 700, 120, 30), { width: 200, height: 300 }, phone);
    expect(placed.above).toBe(true);
    expect(placed.maxHeight).toBe(700 - 6 - 12);
    expect(placed.top).toBe(700 - 6 - 300);
    expect(placed.bottom).toBe(844 - 700 + 6);
  });

  it("caps the height to the larger side when the panel fits neither", () => {
    const placed = placePanel(box(20, 300, 120, 30), { width: 200, height: 900 }, phone);
    expect(placed).toMatchObject({ above: false, maxHeight: 844 - 330 - 6 - 12, top: 336 });
  });

  it("keeps a scrolling list below while that side still offers minRoom", () => {
    const anchor = box(20, 500, 120, 30);
    const list = { width: 200, height: 400 };
    expect(placePanel(anchor, list, phone, { minRoom: 200 }).above).toBe(false);
    expect(placePanel(anchor, list, phone).above).toBe(true);
  });

  it("drops a tooltip below its trigger when it would run past the viewport top", () => {
    const placed = placePanel(box(100, 30, 14, 14), { width: 200, height: 60 }, phone, {
      align: "center",
      prefer: "above",
      gap: 8,
    });
    expect(placed).toMatchObject({ above: false, top: 52 });
  });
});

describe("placeChartTip", () => {
  const plot = box(16, 300, 300, 52);
  const tip = { width: 150, height: 64 };

  it("sits above the plot, centred on the pointer, clear of both the pointer and the hovered point", () => {
    const placed = placeChartTip(plot, { x: 160, y: 330, touch: false }, tip, phone);
    expect(placed).toMatchObject({ above: true, left: 85, top: 300 - 8 - 64 });
    expect(placed.top + tip.height).toBeLessThan(plot.top);
  });

  it("keeps a fingertip of room above a touch near the plot's top edge", () => {
    const placed = placeChartTip(plot, { x: 160, y: 305, touch: true }, tip, phone);
    expect(placed.top + tip.height).toBe(305 - 32 - 8);
  });

  it("drops below the plot, past the mouse arrow, when the viewport has no room above", () => {
    const top = box(16, 20, 300, 52);
    const placed = placeChartTip(top, { x: 160, y: 66, touch: false }, tip, phone);
    expect(placed).toMatchObject({ above: false, top: 66 + 24 + 8 });
  });

  it("stays inside the viewport near its edges", () => {
    expect(placeChartTip(plot, { x: 20, y: 330, touch: false }, tip, phone).left).toBe(12);
    expect(placeChartTip(plot, { x: 380, y: 330, touch: false }, tip, phone).left).toBe(
      390 - 12 - 150,
    );
  });
});

it("reads a pointer relative to the element tracking it", () => {
  const currentTarget = {
    getBoundingClientRect: () => ({ ...box(40, 100, 200, 50), width: 200 }),
  } as unknown as Element;
  expect(
    trackedPointer({ clientX: 90, clientY: 120, pointerType: "touch", currentTarget }),
  ).toEqual({
    x: 50,
    y: 20,
    touch: true,
    width: 200,
  });
  expect(
    trackedPointer({ clientX: 40, clientY: 100, pointerType: "mouse", currentTarget }).touch,
  ).toBe(false);
});
