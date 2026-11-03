import { useCallback, useState } from "react";

/**
 * A spinner held on for at least `ms`: a DNS check can answer in well under
 * a blink, and a spinner that never shows reads as a click that did nothing.
 */
export function useMinSpin(ms = 600): [spinning: boolean, start: () => void] {
  const [spinning, setSpinning] = useState(false);
  const start = useCallback(() => {
    setSpinning(true);
    setTimeout(() => setSpinning(false), ms);
  }, [ms]);
  return [spinning, start];
}
