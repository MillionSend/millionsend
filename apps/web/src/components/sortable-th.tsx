"use client";

export type SortDir = "asc" | "desc";

/**
 * A table header the list sorts on: a caret that reads ↕ at rest and ↑/↓
 * once the column is active, and aria-sort for assistive tech. The click
 * flips an active column and starts a new one on its default direction.
 */
export function SortableTh({
  column,
  label,
  sort,
  dir,
  onSort,
  defaultDir = "desc",
  right = false,
  style,
}: {
  column: string;
  label: string;
  sort: string;
  dir: SortDir;
  onSort: (column: string, dir: SortDir) => void;
  defaultDir?: SortDir;
  right?: boolean;
  style?: React.CSSProperties;
}) {
  const active = sort === column;
  return (
    <th
      className={right ? "right ms-th-sortable" : "ms-th-sortable"}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
      style={style}
    >
      <button
        type="button"
        onClick={() => onSort(column, active ? (dir === "asc" ? "desc" : "asc") : defaultDir)}
      >
        {label}
        <span className="ms-th-caret" aria-hidden="true">
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
