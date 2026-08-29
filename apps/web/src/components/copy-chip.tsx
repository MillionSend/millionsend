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

/**
 * Copy→check icon swap with the pop animation every copy affordance shares
 * (the LP's .lp-copy is the reference). Render inside any copy button;
 * `useCopy` supplies the flag. Reduced motion drops the pop in CSS.
 */
export function CopyMark({ copied, size = 13 }: { copied: boolean; size?: number }) {
  return (
    <span className={`ms-copy-mark${copied ? " done" : ""}`} aria-hidden="true">
      {copied ? (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 12.5 5 5L20 6.5" />
        </svg>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="12" height="12" rx="2.5" />
          <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
        </svg>
      )}
    </span>
  );
}

/** Mono chip with a copy→check affordance. `display` masks what's shown; the full `value` is copied. */
export function CopyChip({
  value,
  display,
  title,
}: {
  value: string;
  display?: React.ReactNode;
  title?: string;
}) {
  const { copied, copy, label } = useCopy(value);
  return (
    <span className="ms-chip" {...(title ? { title } : {})}>
      {/* Width-constrained chips (table cells) end-ellipsize; the full value is copied.
          minWidth 0 lets this flex item shrink below the nowrap value's min-content,
          otherwise it overflows the chip's max-width instead of ellipsizing. */}
      <span
        style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {display ?? value}
      </span>
      <button type="button" onClick={copy} aria-label={label}>
        <CopyMark copied={copied} size={12} />
      </button>
    </span>
  );
}

/** Bare copy→check button for table cells where a chip frame would be noise. */
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
        display: "inline-flex",
        verticalAlign: "middle",
      }}
    >
      <CopyMark copied={copied} />
    </button>
  );
}
