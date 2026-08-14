/** ms-table with the horizontal-scroll container wide data tables need. */
export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="ms-table">{children}</table>
    </div>
  );
}
