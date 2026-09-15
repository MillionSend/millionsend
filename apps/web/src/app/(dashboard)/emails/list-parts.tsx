"use client";

import { useEffect, useRef } from "react";
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
    // Search takes whatever the row has left, so the fixed-width selects end
    // flush with the table's right edge.
    <span style={{ flex: "1 1 160px", minWidth: 0 }}>
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
  tone,
}: {
  headline: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
  /** `error` marks a failed load (glyph); a filtered-empty list stays plain. */
  tone?: "error";
}) {
  return (
    <div className="ms-card ms-state">
      {tone === "error" ? (
        <span className="ms-state-glyph" aria-hidden="true">
          !
        </span>
      ) : null}
      <p className="ms-state-headline">{headline}</p>
      {detail ? <p className="ms-state-body">{detail}</p> : null}
      <div className="ms-state-actions">
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onAction}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

// The footer moved to components/list-footer.tsx (the console shares it); the
// Emails-area callers keep importing it from here.
export { ListFooter, PAGE_SIZES } from "@/components/list-footer";
