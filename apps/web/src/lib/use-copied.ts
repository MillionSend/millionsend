"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Clipboard write plus the transient "✓ Copied" flag list rows and detail
 * pages show for 1.6s. `copied` holds the last-copied value so a caller
 * rendering several copy targets can match feedback to the right one.
 */
export function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600);
  }, []);
  return { copied, copy };
}
