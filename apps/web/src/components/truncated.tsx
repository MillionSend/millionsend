"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "@/components/tooltip";

/**
 * One line that ends in an ellipsis where the column runs out; the whole
 * text shows in a tooltip only once it was actually cut. The parent sets the
 * width: a flex item with min-width 0 inside a fixed-layout table cell.
 */
export function Truncated({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  // Re-attached when `cut` flips: the span is remounted under the tooltip's
  // trigger then, and the observer must follow the new element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cut` is the remount signal, not an input.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cut]);
  const line = (
    <span ref={ref} className="ms-truncate">
      {text}
    </span>
  );
  return cut ? (
    <Tooltip inline triggerClassName="ms-truncate-host" text={text}>
      {line}
    </Tooltip>
  ) : (
    line
  );
}
