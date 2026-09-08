"use client";

import { useLayoutEffect, useState } from "react";

const VIEWPORT_MARGIN = 16;
const ANCHOR_GAP = 6;
const MIN_HEIGHT = 160;

/**
 * Fixed placement for a panel portaled to <body> and pinned to its anchor:
 * below it, flipping above when below is cramped and above has more room;
 * left-aligned, hanging from the anchor's right edge when it would overflow
 * the viewport. Follows scrolls (capture, so nested containers count) and
 * resizes, and is capped to the viewport gap it chose so a tall panel scrolls
 * instead of running off-screen. A layout effect, so the first paint is
 * already placed and focus can move into the panel at once. `anchor` is null
 * while the panel is closed.
 */
export function useAnchoredPanel(
  anchor: HTMLElement | null,
  opts: {
    /** Fixed panel width; without it the panel is at least as wide as the anchor. */
    width?: number;
    /** Own cap on the panel height, applied on top of the viewport gap. */
    maxHeight?: number;
    /** Space below the anchor worth keeping before flipping above it. */
    flipThreshold?: number;
  } = {},
): React.CSSProperties {
  const { width, maxHeight, flipThreshold = 200 } = opts;
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const viewportW = document.documentElement.clientWidth;
      const viewportH = document.documentElement.clientHeight;
      const below = viewportH - rect.bottom - VIEWPORT_MARGIN;
      const above = rect.top - VIEWPORT_MARGIN;
      const flip = below < flipThreshold && above > below;
      const alignRight = rect.left + (width ?? rect.width) > viewportW - VIEWPORT_MARGIN;
      const room = Math.max(MIN_HEIGHT, flip ? above : below);
      setStyle({
        position: "fixed",
        ...(width !== undefined ? { width } : { minWidth: rect.width }),
        maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
        maxHeight: maxHeight === undefined ? room : Math.min(maxHeight, room),
        ...(flip
          ? { bottom: viewportH - rect.top + ANCHOR_GAP }
          : { top: rect.bottom + ANCHOR_GAP }),
        ...(alignRight
          ? { right: Math.max(VIEWPORT_MARGIN, viewportW - rect.right) }
          : { left: rect.left }),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, width, maxHeight, flipThreshold]);
  return style;
}
