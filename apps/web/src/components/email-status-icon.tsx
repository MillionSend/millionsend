/**
 * Status-tinted email visuals: the envelope tile that marks email rows and the
 * detail header (color follows the email's latest status), and the per-event
 * glyphs the delivery timeline uses. All pure SVG on design tokens.
 */
import { StatusTile } from "./status-tile";

/** Tone per email/event status — mirrors the ledger colors used elsewhere. */
export function emailStatusColor(status: string): string {
  switch (status) {
    case "delivered":
      return "var(--ms-success)";
    case "opened":
    case "clicked":
      return "var(--ms-info)";
    case "bounced":
    case "suppressed":
    case "failed":
    case "rendering_failure":
      return "var(--ms-danger)";
    case "complained":
      return "var(--ms-warn)";
    case "delivery_delayed":
      return "var(--ms-neutral)";
    default:
      // queued / queued_quota / sent / canceled — the baseline, not an outcome.
      return "var(--ms-muted)";
  }
}

/** Rounded-square envelope tile tinted by status. */
export function EmailStatusIcon({ status, size = 28 }: { status: string; size?: number }) {
  const glyph = Math.round(size * 0.5);
  return (
    <StatusTile color={emailStatusColor(status)} size={size}>
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="1.5" y="3.2" width="13" height="9.6" rx="1.8" />
        <path d="m2.2 4.4 5.8 4.4 5.8-4.4" />
      </svg>
    </StatusTile>
  );
}

/** Per-event glyph for the delivery timeline (16px grid, stroke currentColor). */
export function EventGlyph({ type, size = 15 }: { type: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (type) {
    case "sent":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M14 2 7.3 8.7M14 2 9.7 14l-2.4-5.3L2 6.3 14 2Z" />
        </svg>
      );
    case "delivered":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="m5.2 8.2 2 2 3.6-4" />
        </svg>
      );
    case "opened":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M2 6.5 8 2l6 4.5V13a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 13V6.5Z" />
          <path d="m2.3 7 5.7 4 5.7-4" />
        </svg>
      );
    case "clicked":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 2.5 7 13l1.6-4.4L13 7 3 2.5Z" />
          <path d="m9.5 9.5 4 4" />
        </svg>
      );
    case "bounced":
    case "failed":
    case "rendering_failure":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6" />
        </svg>
      );
    case "complained":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3.5 14V2.6M3.5 3h8.6l-1.8 2.9 1.8 2.9H3.5" />
        </svg>
      );
    case "suppressed":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M3.6 12.4 12.4 3.6" />
        </svg>
      );
    case "delivery_delayed":
    case "queued":
    case "queued_quota":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.6V8l2.4 1.6" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
        </svg>
      );
  }
}

/** Timeline node tile: rounded square carrying the event glyph in its tone. */
export function EventIconTile({ type, size = 34 }: { type: string; size?: number }) {
  const color = emailStatusColor(type);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        border: `1px solid color-mix(in srgb, ${color} 45%, var(--ms-line))`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 16%, var(--ms-panel)), color-mix(in srgb, ${color} 5%, var(--ms-panel)))`,
        color,
      }}
    >
      <EventGlyph type={type} />
    </span>
  );
}
