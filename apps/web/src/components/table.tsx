/** ms-table with the horizontal-scroll container wide data tables need. */
export function Table({
  children,
  className,
  style,
  gutter,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Left gutter (px) kept INSIDE the scroll box so row controls hung
   *  outside the first column (bulk-select boxes) are not clipped. */
  gutter?: number;
}) {
  return (
    <div
      style={{ overflowX: "auto", paddingLeft: gutter, marginLeft: gutter ? -gutter : undefined }}
    >
      <table className={className ? `ms-table ${className}` : "ms-table"} style={style}>
        {children}
      </table>
    </div>
  );
}
