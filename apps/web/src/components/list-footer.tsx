"use client";

import { Select } from "@/components/select";

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
