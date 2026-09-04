import { useEffect } from "react";

let locks = 0;
let saved = "";

/**
 * Holds the page still while an overlay (modal, drawer) is open, so the wheel
 * and touch scroll only the overlay. Counted, so a dialog opened over a drawer
 * releases the page only when both are gone.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (locks === 0) saved = document.body.style.overflow;
    locks += 1;
    document.body.style.overflow = "hidden";
    return () => {
      locks -= 1;
      if (locks === 0) document.body.style.overflow = saved;
    };
  }, [active]);
}
