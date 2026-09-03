import Link from "next/link";

const TONES = {
  warn: { color: "var(--ms-warn)", bg: "var(--ms-warn-bg)", border: "var(--ms-warn-border)" },
  danger: {
    color: "var(--ms-danger)",
    bg: "var(--ms-danger-bg)",
    border: "var(--ms-danger-border)",
  },
} as const;

/**
 * The dashboard's global notice strip: one line of text, optionally a link,
 * no ghost while absent.
 */
export function NoticeStrip({
  href,
  tone,
  text,
  action,
}: {
  href?: string | undefined;
  tone: keyof typeof TONES;
  text: string;
  action?: string | undefined;
}) {
  const t = TONES[tone];
  const body = (
    <>
      <span>{text}</span>
      {action ? (
        <span style={{ marginLeft: "auto", opacity: 0.8, whiteSpace: "nowrap" }}>{action} →</span>
      ) : null}
    </>
  );
  const style = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 14px",
    marginBottom: 18,
    borderRadius: "var(--ms-r-input)",
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.color,
    fontSize: 13,
    lineHeight: 1.4,
    textDecoration: "none",
  } as const;
  return href ? (
    <Link href={href} style={style}>
      {body}
    </Link>
  ) : (
    <div role="status" style={style}>
      {body}
    </div>
  );
}
