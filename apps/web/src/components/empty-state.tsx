/** Count-first empty state: "0 API keys." then a flat one-line body. */
export function EmptyState({ headline, body }: { headline: string; body?: string }) {
  return (
    <div className="ms-card" style={{ padding: "56px 24px", textAlign: "center" }}>
      <p style={{ margin: 0, color: "var(--ms-bone)", fontSize: "var(--ms-fs-body)" }}>
        {headline}
      </p>
      {body ? (
        <p style={{ margin: "6px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
          {body}
        </p>
      ) : null}
    </div>
  );
}
