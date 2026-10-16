"use client";

import Link from "next/link";
import { Skeleton } from "@/components/skeleton";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";

/** A lucide glyph in a list's 28px tile: about 1.2px of stroke, the envelope glyph's weight. */
export const LEAD_GLYPH = { size: 14, strokeWidth: 2 } as const;

/**
 * A list row's first cell, on one line: an optional status tile, the row's
 * value (an address or a title) ending in an ellipsis where the column runs
 * out and whole in a tooltip, "+N" for the addresses behind the first, and
 * an optional muted tail that gives way before the value does. Phones keep
 * the whole line and scroll the list sideways.
 */
export function LeadCell({
  tile,
  value,
  href,
  mono = false,
  more = [],
  tail,
}: {
  tile?: React.ReactNode;
  value: string;
  /** Where the value links; the row's own click goes there too. */
  href?: string;
  /** Mono type, for addresses. */
  mono?: boolean;
  /** The addresses behind the first: counted as "+N" and listed in its tooltip. */
  more?: readonly string[];
  /** A string tail shows whole in a tooltip once cut. */
  tail?: React.ReactNode;
}) {
  const line = <Truncated text={value} />;
  return (
    <td className={mono ? "ms-cell-fill ms-mono" : "ms-cell-fill"}>
      <span className="ms-lead">
        {tile}
        {href ? (
          <Link href={href} className="ms-lead-value" onClick={(event) => event.stopPropagation()}>
            {line}
          </Link>
        ) : (
          <span className="ms-lead-value">{line}</span>
        )}
        {more.length > 0 ? (
          <Tooltip inline text={more.join(", ")}>
            <span className="ms-lead-more">+{more.length}</span>
          </Tooltip>
        ) : null}
        {tail ? (
          <span className="ms-lead-tail">
            {typeof tail === "string" ? <Truncated text={tail} /> : tail}
          </span>
        ) : null}
      </span>
    </td>
  );
}

/** A lead cell's loading stand-in, tile and value, so a loaded row keeps its height. */
export function SkeletonLead({ width }: { width: number | string }) {
  return (
    <span className="ms-lead">
      <Skeleton width={30} height={30} radius={8} />
      <Skeleton width={width} height={13} />
    </span>
  );
}
