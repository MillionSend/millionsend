import Link from "next/link";

type Tone = "info" | "warn" | "danger";

/**
 * The dashboard's global notice strip: one line of text, optionally a link,
 * no ghost while absent. Drawn like the toasts — tone border and a glow rising
 * from the bottom-left corner — so a warning reads as the same family as a
 * success, not as a flat filled box.
 */
export function NoticeStrip({
  href,
  tone,
  text,
  action,
}: {
  href?: string | undefined;
  tone: Tone;
  text: string;
  action?: string | undefined;
}) {
  const className = `ms-notice-strip ms-notice-strip-${tone}`;
  const body = (
    <>
      <span>{text}</span>
      {action ? <span className="ms-notice-strip-action">{action} →</span> : null}
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div role="status" className={className}>
      {body}
    </div>
  );
}
