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
export function ListSkeleton({
  headers,
  action = false,
}: {
  headers: [string, string, string, string];
  /**
   * Last column holds the 28px bare overflow trigger instead of a relative
   * time (suppressions); the trigger is the row's tallest content, so its
   * stand-in must keep that height. Also switches the header widths to the
   * suppressions table's (40/18% vs the emails table's 34/15%).
   */
  action?: boolean;
}) {
  const widths = ["58%", "42%", "66%", "50%", "38%", "62%", "46%", "54%"];
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: action ? "40%" : "34%" }}>{headers[0]}</th>
          <th style={{ width: action ? "18%" : "15%" }}>{headers[1]}</th>
          <th>{headers[2]}</th>
          {action ? (
            <th className="right" />
          ) : (
            <th className="right" style={{ width: "13%" }}>
              {headers[3]}
            </th>
          )}
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
            {action ? (
              <td className="right" style={{ width: 40 }}>
                <Skeleton width={28} height={28} radius={8} />
              </td>
            ) : (
              <td className="right">
                <Skeleton width={48} />
              </td>
            )}
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

/** "Page 1 – N of M" footer with the list's controls at the right: the
 * page-size chooser, then "Load more" (when there is a next page). The
 * chooser only renders when paging is real — when everything already fits
 * one page, a size choice could only add pagination, never remove it. Omit
 * the chooser props entirely for a static count on an unpaginated list. */
export function ListFooter({
  left,
  size,
  onSize,
  sizeLabel,
  singlePage = false,
  loadMore,
}: {
  left?: string;
  size?: number;
  onSize?: (size: number) => void;
  sizeLabel?: (size: number) => string;
  /** True when everything already fits one page (no next page, page 1). */
  singlePage?: boolean;
  /** Pass only while a next page exists; `loading` disables the button. */
  loadMore?: { label: string; onClick: () => void; loading?: boolean } | undefined;
}) {
  const showChooser = size !== undefined && onSize && sizeLabel && !singlePage;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        marginTop: 14,
        fontSize: 13,
        color: "var(--ms-muted)",
      }}
    >
      <span>{left}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {showChooser ? (
          <Select
            button
            value={String(size)}
            onChange={(next) => onSize(Number(next))}
            options={PAGE_SIZES.map((s) => ({ value: String(s), label: sizeLabel(s) }))}
            ariaLabel={sizeLabel(size)}
          />
        ) : null}
        {loadMore ? (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={loadMore.onClick}
            disabled={loadMore.loading}
          >
            {loadMore.label}
          </button>
        ) : null}
      </span>
    </div>
  );
}
