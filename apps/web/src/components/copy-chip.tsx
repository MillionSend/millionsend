"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

function useCopy(value: string) {
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

  return { copied, copy, label: copied ? t("copied") : t("copy") };
}

/** Mono chip with a ⧉→✓ copy affordance. `display` masks what's shown; the full `value` is copied. */
export function CopyChip({ value, display }: { value: string; display?: React.ReactNode }) {
  const { copied, copy, label } = useCopy(value);
  return (
    <span className="ms-chip">
      {/* Width-constrained chips (table cells) end-ellipsize; the full value is copied. */}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {display ?? value}
      </span>
      <button type="button" onClick={copy} aria-label={label}>
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

/** Bare ⧉→✓ copy button for table cells where a chip frame would be noise. */
export function CopyGlyph({ value }: { value: string }) {
  const { copied, copy, label } = useCopy(value);
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      style={{
        background: "none",
        border: 0,
        padding: 0,
        marginLeft: 6,
        cursor: "pointer",
        color: "var(--ms-muted)",
        font: "inherit",
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
