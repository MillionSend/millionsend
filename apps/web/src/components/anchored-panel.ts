"use client";

import { useEffectEvent, useLayoutEffect, useState } from "react";
import {
  PANEL_MAX_WIDTH,
  type PanelPlacement,
  placePanel,
  viewportSize,
} from "@/lib/panel-placement";

const ANCHOR_GAP = 6;
const MIN_HEIGHT = 160;

/**
 * Fixed placement for a panel portaled to <body> and pinned to its anchor:
 * below it, flipping above when below is cramped and above has more room;
 * left-aligned, hanging from the anchor's right edge when it would overflow
 * the viewport, and shifted to stay inside it. The panel is measured, so
 * `panel` must be the ref of the element the returned style goes on.
 * Follows scrolls (capture, so nested containers count) and resizes, and is
 * capped to the viewport gap it chose so a tall panel scrolls instead of
 * running off-screen. `onAnchorHidden` runs once the anchor has scrolled
 * fully out of the viewport, for a panel that should close rather than follow
 * it off-screen. A layout effect, so the first paint is already placed.
 * `anchor` is null while the panel is closed.
 */
export function useAnchoredPanel(
  anchor: HTMLElement | null,
  panel: React.RefObject<HTMLElement | null>,
  opts: {
    /** Fixed panel width; without it the panel is at least as wide as the anchor. */
    width?: number;
    /** Own cap on the panel height, applied on top of the viewport gap. */
    maxHeight?: number;
    /** Space below the anchor worth keeping before flipping above it. */
    flipThreshold?: number;
    onAnchorHidden?: () => void;
  } = {},
): React.CSSProperties {
  const { width, maxHeight, flipThreshold = 200, onAnchorHidden } = opts;
  const [placed, setPlaced] = useState<(PanelPlacement & { anchorWidth: number }) | null>(null);
  const anchorHidden = useEffectEvent(() => {
    if (!onAnchorHidden) return false;
    onAnchorHidden();
    return true;
  });
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = viewportSize();
      if ((rect.bottom < 0 || rect.top > viewport.height) && anchorHidden()) return;
      const el = panel.current;
      setPlaced({
        ...placePanel(
          rect,
          { width: el?.offsetWidth ?? width ?? rect.width, height: el?.offsetHeight ?? 0 },
          viewport,
          { gap: ANCHOR_GAP, minRoom: flipThreshold },
        ),
        anchorWidth: rect.width,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      setPlaced(null);
    };
  }, [anchor, panel, width, flipThreshold]);

  // Unmeasured, the first render hangs under the anchor; the layout effect
  // corrects it before paint. It stays visible so an autofocused field lands.
  const rect = anchor && !placed ? anchor.getBoundingClientRect() : undefined;
  const room = placed ? Math.max(MIN_HEIGHT, placed.maxHeight) : undefined;
  return {
    position: "fixed",
    ...(width !== undefined ? { width } : { minWidth: placed?.anchorWidth ?? rect?.width ?? 0 }),
    maxWidth: PANEL_MAX_WIDTH,
    ...(placed && room !== undefined
      ? {
          left: placed.left,
          ...(placed.above ? { bottom: placed.bottom } : { top: placed.top }),
          maxHeight: maxHeight === undefined ? room : Math.min(maxHeight, room),
        }
      : { left: rect?.left ?? 0, top: (rect?.bottom ?? 0) + ANCHOR_GAP }),
  };
}
