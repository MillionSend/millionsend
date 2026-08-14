"use client";

import { useEffect, useRef } from "react";
import { Select } from "@/components/select";

/** Filter-row chrome shared by the Emails-area list screens (emails + suppressions). */

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere on the page.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        ref.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // Search stretches to fill the filter row; the selects keep fixed widths.
    <span style={{ flex: 1, minWidth: 160 }}>
      <input
        ref={ref}
        className="ms-input"
        style={{ width: "100%" }}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

/** Skeleton matching final list geometry — no spinners on lists (canvas rule). */
export function ListSkeleton() {
  const bar = (width: string, height: number, delay: string) => ({
    height,
    width,
    borderRadius: 6,
    background: "var(--ms-inset)",
    animation: `ms-shimmer 1.6s ${delay} infinite`,
  });
  // Widths and stagger delays verbatim from the canvas skeleton spec.
  const rows: Array<[string, string, string, string]> = [
    ["38%", "30%", "0s", ".2s"],
    ["32%", "36%", ".1s", ".3s"],
    ["41%", "26%", ".2s", ".4s"],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "8px 0" }}>
      {rows.map(([w1, w2, d1, d2]) => (
        <div key={w1} style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span style={bar(w1, 11, d1)} />
          <span style={bar("74px", 20, d1)} />
          <span style={bar(w2, 11, d2)} />
        </div>
      ))}
    </div>
  );
}

/** Filtered-to-zero / error card — bordered, centered, one action. */
export function StateCard({
  headline,
  detail,
  actionLabel,
  onAction,
}: {
  headline: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--ms-line)",
        borderRadius: 16,
        padding: 22,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 14.5, fontWeight: 600 }}>{headline}</div>
      {detail ? (
        <div style={{ fontSize: 13, color: "var(--ms-muted)", marginTop: 3 }}>{detail}</div>
      ) : null}
      <button
        type="button"
        className="ms-btn ms-btn-secondary"
        style={{ marginTop: 12 }}
        onClick={onAction}
      >
        {actionLabel}
      </button>
    </div>
  );
}

export const PAGE_SIZES = [25, 40, 50] as const;

/** "Page 1 – N of M" footer with the page-size chooser at the right. */
export function ListFooter({
  left,
  size,
  onSize,
  sizeLabel,
}: {
  left: string;
  size: number;
  onSize: (size: number) => void;
  sizeLabel: (size: number) => string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: 14,
        fontSize: 13,
        color: "var(--ms-muted)",
      }}
    >
      <span>{left}</span>
      <Select
        value={String(size)}
        onChange={(next) => onSize(Number(next))}
        options={PAGE_SIZES.map((s) => ({ value: String(s), label: sizeLabel(s) }))}
        ariaLabel={sizeLabel(size)}
      />
    </div>
  );
}
