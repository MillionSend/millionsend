import { useEffect, useRef } from "react";

/**
 * `value` while it is set, else the last set value seen: a query whose key
 * just changed answers nothing until it loads, and whatever it replaces
 * would blink out meanwhile.
 */
export function useLastDefined<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(null);
  useEffect(() => {
    if (value != null) last.current = value;
  }, [value]);
  return value ?? last.current;
}
