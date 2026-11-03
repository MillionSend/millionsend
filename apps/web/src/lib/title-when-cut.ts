import type { MouseEvent } from "react";

/**
 * For onMouseEnter on a control whose one-line label is marked data-label:
 * the label's whole text as the control's hover title once an ellipsis cut
 * it, and no tooltip that only repeats what already shows.
 */
export function titleWhenCut(event: MouseEvent<HTMLElement>, text: string): void {
  const control = event.currentTarget;
  const label = control.querySelector<HTMLElement>("[data-label]") ?? control;
  control.title = label.scrollWidth > label.clientWidth ? text : "";
}
