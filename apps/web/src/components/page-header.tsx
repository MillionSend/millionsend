import Link from "next/link";

export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
  leading,
}: {
  title: string;
  /** Mono proof strip under the H1 — the resource's own numbers. */
  subtitle?: string;
  /** Breadcrumb row above the H1 ("Emails / Email details"). */
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  /** Identity mark beside the title block (e.g. the email's status tile). */
  leading?: React.ReactNode;
}) {
  return (
    <header className="ms-page-header" style={{ marginBottom: 28 }}>
      {breadcrumb ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            lineHeight: 1,
            marginBottom: 10,
          }}
        >
          {breadcrumb}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: subtitle ? "flex-end" : "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        {leading ? (
          <span style={{ flex: "none", alignSelf: "center", display: "inline-flex" }}>
            {leading}
          </span>
        ) : null}
        <div style={leading ? { flex: 1, minWidth: 0 } : undefined}>
          <h1
            className="ms-display"
            style={{
              fontSize: "var(--ms-fs-h1)",
              color: "var(--ms-bone)",
              margin: 0,
            }}
          >
            {title}
          </h1>
          {subtitle ? (
            <div
              className="ms-mono"
              style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 8 }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

/** A non-terminal breadcrumb segment plus its "/" separator. */
export function Crumb({ href, label }: { href: string; label: string }) {
  return (
    <>
      <Link href={href} className="ms-crumb">
        {label}
      </Link>
      <span style={{ color: "var(--ms-faint)" }}>/</span>
    </>
  );
}

/** The terminal (current-page) breadcrumb segment. */
export function CrumbEnd({ label }: { label: string }) {
  return <span style={{ color: "var(--ms-muted)" }}>{label}</span>;
}
