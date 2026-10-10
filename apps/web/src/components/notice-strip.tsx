import Link from "next/link";

type Tone = "info" | "warn" | "danger";

/**
 * The dashboard's global notice strip: a line of text, optionally a trailing
 * action, no ghost while absent. Drawn like the toasts — tone border and a
 * glow rising from the bottom-left corner — so a warning reads as the same
 * family as a success, not as a flat filled box. With `href` the whole strip
 * is the link; with `onAction` the action is a button (an in-page dialog).
 * The action drops onto its own line under the text whenever the text would
 * be squeezed beside it.
 */
export function NoticeStrip({
  href,
  tone,
  text,
  action,
  onAction,
}: {
  href?: string | undefined;
  tone: Tone;
  text: string;
  action?: string | undefined;
  onAction?: (() => void) | undefined;
}) {
  const className = `ms-notice-strip ms-notice-strip-${tone}`;
  const label = action ? `${action} →` : null;
  const body = (
    <>
      <span className="ms-notice-strip-text">{text}</span>
      {label && onAction ? (
        <button type="button" className="ms-notice-strip-action" onClick={onAction}>
          {label}
        </button>
      ) : label ? (
        <span className="ms-notice-strip-action">{label}</span>
      ) : null}
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
