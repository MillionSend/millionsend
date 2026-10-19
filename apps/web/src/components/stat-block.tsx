"use client";

import { Odometer } from "@/components/odometer";
import { Skeleton } from "@/components/skeleton";

/**
 * Uppercase microlabel over big tabular digits — the stat-strip KPI block
 * (audience contacts, broadcast detail). Loaded values roll in on the shared
 * Odometer; the ghost keeps the digit line box so the strip never shifts.
 */
export function StatBlock({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  /** Muted line under the digits — a qualifier the number needs to be honest. */
  hint?: string | undefined;
}) {
  return (
    <div>
      <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
        {label}
      </div>
      <div
        className="ms-digits"
        style={{
          fontSize: "var(--ms-fs-kpi)",
          color: "var(--ms-bone)",
          marginTop: 6,
          display: "flex",
        }}
      >
        {value != null ? <Odometer formatted={value} /> : <Skeleton width={64} height="1lh" />}
      </div>
      {hint ? (
        <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 4 }}>{hint}</div>
      ) : null}
    </div>
  );
}

/** The row of StatBlocks between two rules, wrapping by content. */
export function StatStrip({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="ms-meta-grid ms-stat-strip"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 22,
        padding: "20px 0",
        borderTop: "1px solid var(--ms-line)",
        borderBottom: "1px solid var(--ms-line)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
