import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Scrolls `row` sideways just enough to show `el`. Adjusts the row's own
 * scrollLeft rather than calling scrollIntoView, which would also drag the
 * page vertically whenever the row sits outside the viewport.
 */
export function revealInRow(row: Element, el: Element): void {
  const r = row.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  if (e.left < r.left) row.scrollLeft -= r.left - e.left;
  else if (e.right > r.right) row.scrollLeft += e.right - r.right;
}

/**
 * Ref for a `.ms-tabs` row whose buttons navigate. Such a row remounts with
 * its page, so scrollLeft restarts at 0 and the tab just clicked can land off
 * screen; whenever `activeKey` changes (mount included) the `.active` button
 * is brought back into view. Layout-phase so the row never paints scrolled
 * to the wrong place first.
 */
export function useActiveTabInView(
  activeKey: string | null | undefined,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    const active = row?.querySelector(".active");
    if (activeKey && row && active) revealInRow(row, active);
  }, [activeKey]);
  return ref;
}
