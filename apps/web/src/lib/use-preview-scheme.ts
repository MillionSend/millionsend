"use client";

import { useState } from "react";
import type { EmailScheme } from "./email-preview";
import { useTheme } from "./use-theme";

/**
 * Which mail client a preview imitates. It follows the dashboard's theme
 * until the reader picks one, then holds that choice for the page.
 */
export function usePreviewScheme(): [EmailScheme, (scheme: EmailScheme) => void] {
  const theme = useTheme();
  const [override, setOverride] = useState<EmailScheme | null>(null);
  return [override ?? (theme === "dark" ? "dark" : "light"), setOverride];
}
