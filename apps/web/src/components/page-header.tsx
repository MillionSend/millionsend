export function PageHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        marginBottom: 28,
      }}
    >
      <h1
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", margin: 0 }}
      >
        {title}
      </h1>
      {actions ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>{actions}</div>
      ) : null}
    </header>
  );
}
