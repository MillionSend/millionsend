"use client";

import { useEffect, useRef } from "react";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { Table } from "@/components/table";

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

/**
 * Loading stand-in mirroring the Emails-area list tables — real header
 * labels over rows shaped like the loaded columns (mono link, badge, text,
 * right-aligned time). No spinners on lists.
 */
export function ListSkeleton({ headers }: { headers: [string, string, string, string] }) {
  const widths = ["58%", "42%", "66%", "50%", "38%", "62%", "46%", "54%"];
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: "36%" }}>{headers[0]}</th>
          <th style={{ width: "16%" }}>{headers[1]}</th>
          <th>{headers[2]}</th>
          <th className="right" style={{ width: "13%" }}>
            {headers[3]}
          </th>
        </tr>
      </thead>
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <SkeletonBadge />
            </td>
            <td>
              <Skeleton width={widths[widths.length - 1 - row] ?? "50%"} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
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
