/**
 * Settings and billing card: a display title with an optional action on its
 * row (the card's primary action). The action drops under the title when the
 * two do not fit side by side, rather than squeezing the title.
 */
export function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "10px 12px",
          margin: "0 0 18px",
        }}
      >
        <h2
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: 0 }}
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
