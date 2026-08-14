/** ms-table with the horizontal-scroll container wide data tables need. */
export function Table({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className={className ? `ms-table ${className}` : "ms-table"} style={style}>
        {children}
      </table>
    </div>
  );
}
