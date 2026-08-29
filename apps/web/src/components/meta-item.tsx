/**
 * Labeled cell of a detail page's meta grid. The value row is a centered
 * flex line with a fixed min-height, so mixed-height values in one grid — an
 * id CopyChip (~26px) beside a status badge (~22px) — share a vertical
 * center instead of hanging from uneven tops.
 */
export function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
        {label}
      </p>
      <div
        style={{
          marginTop: 5,
          minHeight: 26,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          fontSize: 14,
          color: "var(--ms-bone)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
