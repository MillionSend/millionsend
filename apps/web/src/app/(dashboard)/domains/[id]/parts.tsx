import { DotParts } from "@/components/dot-parts";

export function ConfigSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ms-config-section">
      <h3 style={{ fontSize: 14, fontWeight: 500, color: "var(--ms-bone)", margin: 0 }}>{title}</h3>
      {description ? (
        <p style={{ fontSize: 12.5, color: "var(--ms-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
          {description}
        </p>
      ) : null}
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

/** A plain status line on the domain page: a " · "-joined fact, then a muted note. */
export function StatusRow({ text, note }: { text: string; note: string }) {
  return (
    <div
      role="status"
      className="ms-wrap-row"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        fontSize: 13.5,
        border: "1px solid var(--ms-line)",
        borderRadius: 12,
        padding: "11px 16px",
      }}
    >
      <span style={{ color: "var(--ms-bone)" }}>
        <DotParts text={text} />
      </span>
      <span style={{ color: "var(--ms-muted)" }}>{note}</span>
    </div>
  );
}
