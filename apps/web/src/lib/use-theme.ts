"use client";

import { useEffect, useState } from "react";
import { currentTheme, type Theme } from "./theme";

/**
 * Reactive app theme. The account-menu toggle flips the html[data-theme]
 * attribute (lib/theme.ts), so a MutationObserver on that attribute is the
 * single change signal — no context/provider needed.
 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "dark" : currentTheme(),
  );
  useEffect(() => {
    setTheme(currentTheme());
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
