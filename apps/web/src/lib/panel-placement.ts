/** Room every floating panel keeps from the viewport edges: menus, listboxes, tooltips, chart tips. */
export const PANEL_MARGIN = 12;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The start of a `size`-long span moved, if needed, to stay `margin` inside
 * `[0, extent]`. A span longer than the room left starts at the margin.
 */
export function clampInto(
  start: number,
  size: number,
  extent: number,
  margin: number = PANEL_MARGIN,
): number {
  return Math.max(margin, Math.min(start, extent - margin - size));
}

export interface PanelPlacement {
  left: number;
  top: number;
  /** Viewport bottom to the panel's bottom edge: a panel above its anchor that may grow is pinned by it. */
  bottom: number;
  /** The room on the chosen side: a panel capped to it scrolls instead of leaving the viewport. */
  maxHeight: number;
  above: boolean;
}

/**
 * Fixed-position placement of a floating panel next to its anchor, in viewport
 * coordinates. Vertically the panel takes the preferred side while it fits
 * there (or while that side offers `minRoom`, for a list that may scroll),
 * and otherwise whichever side has more room. Horizontally it lines up with
 * the anchor's start, end or centre, then shifts to stay `margin` inside the
 * viewport; a panel wider than the viewport allows counts as capped to it, so
 * the caller must cap it the same way (max-width).
 */
export function placePanel(
  anchor: Box,
  panel: Size,
  viewport: Size,
  {
    align = "start",
    prefer = "below",
    gap = 6,
    margin = PANEL_MARGIN,
    minRoom = Number.POSITIVE_INFINITY,
  }: {
    align?: "start" | "end" | "center";
    prefer?: "below" | "above";
    gap?: number;
    margin?: number;
    minRoom?: number;
  } = {},
): PanelPlacement {
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const [first, second] = prefer === "below" ? [below, above] : [above, below];
  const keep = first >= Math.min(panel.height, minRoom) || first >= second;
  const isAbove = (prefer === "above") === keep;
  const room = Math.max(0, isAbove ? above : below);
  const height = Math.min(panel.height, room);

  const width = Math.min(panel.width, viewport.width - 2 * margin);
  // An edge-aligned panel that would cross the viewport edge tries the
  // anchor's other edge before being shifted.
  const fitsStart = anchor.left + width <= viewport.width - margin;
  const fitsEnd = anchor.right - width >= margin;
  const fromStart = align === "start" ? fitsStart || !fitsEnd : fitsStart && !fitsEnd;
  const start =
    align === "center"
      ? (anchor.left + anchor.right - width) / 2
      : fromStart
        ? anchor.left
        : anchor.right - width;

  const top = isAbove ? anchor.top - gap - height : anchor.bottom + gap;
  return {
    left: clampInto(start, width, viewport.width, margin),
    top,
    bottom: viewport.height - top - height,
    maxHeight: room,
    above: isAbove,
  };
}

/** A pointer over a chart, relative to the element tracking it, and whether a finger or pen drives it. */
export interface ChartPointer {
  x: number;
  y: number;
  touch: boolean;
}

/** The pointer of an event, relative to the element whose handler it reached, plus that element's width. */
export function trackedPointer(event: {
  clientX: number;
  clientY: number;
  pointerType: string;
  currentTarget: Element;
}): ChartPointer & { width: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    touch: event.pointerType !== "mouse",
    width: rect.width,
  };
}

/* How far a chart tip keeps from the pointer: a mouse arrow hangs below its
   hot spot. A fingertip covers its touch point and a margin around it, and
   the finger and hand cover everything below it. */
const MOUSE_CLEARANCE = { above: 4, below: 24 };
const FINGERTIP = { above: 32, halfWidth: 22 };
const CHART_TIP_GAP = 8;

/**
 * Where a chart's hover tip goes, in viewport coordinates: above the plot,
 * centred on the pointer's x and shifted to stay inside the viewport. With
 * a mouse it drops below the plot when the viewport has less room above;
 * under a finger it never does (the hand would hide it), and instead rises
 * from above the fingertip beside the touched column, over the rest of the
 * plot. It never covers the pointer or the hovered point.
 */
export function placeChartTip(
  plot: Box,
  pointer: ChartPointer,
  tip: Size,
  viewport: Size,
): PanelPlacement {
  const options = { align: "center", prefer: "above", gap: CHART_TIP_GAP } as const;
  if (!pointer.touch) {
    return placePanel(
      {
        left: pointer.x,
        right: pointer.x,
        top: Math.min(plot.top, pointer.y - MOUSE_CLEARANCE.above),
        bottom: Math.max(plot.bottom, pointer.y + MOUSE_CLEARANCE.below),
      },
      tip,
      viewport,
      options,
    );
  }
  const abovePlot = placePanel(
    {
      left: pointer.x,
      right: pointer.x,
      top: Math.min(plot.top, pointer.y - FINGERTIP.above),
      bottom: plot.bottom,
    },
    tip,
    viewport,
    options,
  );
  if (abovePlot.above && abovePlot.maxHeight >= tip.height) return abovePlot;
  const width = Math.min(tip.width, viewport.width - 2 * PANEL_MARGIN);
  const beside =
    pointer.x >= viewport.width / 2
      ? pointer.x - FINGERTIP.halfWidth - CHART_TIP_GAP - width
      : pointer.x + FINGERTIP.halfWidth + CHART_TIP_GAP;
  const top = Math.max(PANEL_MARGIN, pointer.y - FINGERTIP.above - CHART_TIP_GAP - tip.height);
  return {
    left: clampInto(beside, width, viewport.width),
    top,
    bottom: viewport.height - top - tip.height,
    maxHeight: viewport.height - top - PANEL_MARGIN,
    above: true,
  };
}

/** The layout viewport, which excludes a classic scrollbar (window.inner* includes it). */
export function viewportSize(): Size {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
}
