"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

/** Mono chip with a ⧉→✓ copy affordance. `display` masks what's shown; the full `value` is copied. */
export function CopyChip({ value, display }: { value: string; display?: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <span className="ms-chip">
      {display ?? value}
      <button type="button" onClick={copy} aria-label={copied ? t("copied") : t("copy")}>
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}
