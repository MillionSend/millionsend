/**
 * Status-tinted email visuals: the envelope tile that marks email rows and the
 * detail header (color follows the email's latest status), and the "Email
 * events" strip the sent and received email pages share: per-event glyphs and
 * tones, the node, the connector and the loading placeholder.
 */
import type {
  QuarantineReason,
  ScreeningVerdict,
  SpamVerdict,
  VirusVerdict,
} from "@millionsend/core";
import { useLocale } from "next-intl";
import {
  DELIVERY_VARIANTS,
  type DeliveryStatus,
} from "@/app/(dashboard)/webhooks/webhook-status-badge";
import { formatDayTime, formatDurationShort, formatUtcTimestampMs } from "@/lib/format";
import {
  BugIcon,
  ForwardIcon,
  InboxIcon,
  LockIcon,
  LockOpenIcon,
  ReplyIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldHalfIcon,
  SpamIcon,
  WebhookIcon,
} from "./icons/mail-icons";
import { Skeleton, SkeletonBadge } from "./skeleton";
import { StatusTile, TONE_COLOR } from "./status-tile";

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
    case "unsubscribed":
      return "var(--ms-warn)";
    case "delivery_delayed":
      return "var(--ms-neutral)";
    default:
      // queued / queued_quota / sent / canceled / prefetched — the baseline,
      // not an outcome.
      return "var(--ms-muted)";
  }
}

/** A lucide glyph at 14px on its 24-unit frame, as heavy as the 16-unit event glyphs. */
const EVENT_ICON_STROKE = 2.4;

/** A received message's step on its events strip, with the facts its tone reads. */
export type ReceivedEventStep =
  | { type: "received" | "quarantined" | "released" | "delivered" | "replied" | "forwarded" }
  | { type: "scanned"; spam: SpamVerdict | null; virus: VirusVerdict | null }
  | { type: "screened"; verdict: ScreeningVerdict; quarantineReason: QuarantineReason | null }
  | { type: "webhook"; status: DeliveryStatus };

/**
 * Tone and glyph per received step, in the sent tones: the pipeline's own
 * steps stay muted, a person acting informs, delivery succeeds, doubt warns,
 * and malware or a hold is a danger. A scan reads top-down, first match wins.
 */
export function receivedEventLook(step: ReceivedEventStep): {
  color: string;
  glyph: React.ReactNode;
} {
  const stroke = EVENT_ICON_STROKE;
  switch (step.type) {
    case "received":
      return { color: TONE_COLOR.neutral, glyph: <InboxIcon strokeWidth={stroke} /> };
    case "scanned":
      if (step.virus === "fail") {
        return { color: TONE_COLOR.danger, glyph: <BugIcon strokeWidth={stroke} /> };
      }
      // Amber like the list's Spam badge: spam is filed away, not held.
      if (step.spam === "fail") {
        return { color: TONE_COLOR.warn, glyph: <SpamIcon strokeWidth={stroke} /> };
      }
      if (step.spam === "gray" || step.virus === "processing_failed") {
        return { color: TONE_COLOR.warn, glyph: <ShieldAlertIcon strokeWidth={stroke} /> };
      }
      return {
        color: TONE_COLOR.neutral,
        // Half a shield when a scanner gave no verdict: no ClamAV leaves the virus verdict null.
        glyph:
          step.spam === "pass" && step.virus === "pass" ? (
            <ShieldCheckIcon strokeWidth={stroke} />
          ) : (
            <ShieldHalfIcon strokeWidth={stroke} />
          ),
      };
    case "screened":
      return {
        color:
          step.quarantineReason === "injection" || step.quarantineReason === "phishing"
            ? TONE_COLOR.danger
            : step.verdict === "suspicious"
              ? TONE_COLOR.warn
              : TONE_COLOR.neutral,
        glyph: <ScanEyeIcon strokeWidth={stroke} />,
      };
    case "quarantined":
      return { color: TONE_COLOR.danger, glyph: <LockIcon strokeWidth={stroke} /> };
    case "released":
      return { color: TONE_COLOR.info, glyph: <LockOpenIcon strokeWidth={stroke} /> };
    case "delivered":
      return { color: emailStatusColor("delivered"), glyph: <EventGlyph type="delivered" /> };
    case "replied":
      return { color: TONE_COLOR.info, glyph: <ReplyIcon strokeWidth={stroke} /> };
    case "forwarded":
      return { color: TONE_COLOR.info, glyph: <ForwardIcon strokeWidth={stroke} /> };
    case "webhook":
      return {
        color: TONE_COLOR[DELIVERY_VARIANTS[step.status]],
        glyph: <WebhookIcon strokeWidth={stroke} />,
      };
  }
}

/** Rounded-square envelope tile tinted by status. */
export function EmailStatusIcon({
  status,
  size = 28,
  label,
}: {
  status: string;
  size?: number;
  label?: string | undefined;
}) {
  return (
    <StatusTile color={emailStatusColor(status)} size={size} label={label}>
      <EnvelopeGlyph size={Math.round(size * 0.5)} />
    </StatusTile>
  );
}

/** The envelope on its 16-unit grid: the mark of an email row, sent or received. */
export function EnvelopeGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
    case "prefetched":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="1.5" y="3.2" width="13" height="9.6" rx="1.8" strokeDasharray="2.2 1.6" />
          <path d="M8 5.2v5M6 8.2l2 2 2-2" />
        </svg>
      );
    case "unsubscribed":
      // An envelope the recipient walked out of: the flap, and an arrow leaving.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M1.5 4.7a1.6 1.6 0 0 1 1.6-1.6h9.8a1.6 1.6 0 0 1 1.6 1.6v3.1" />
          <path d="M1.5 5.2 8 9.4l6.5-4.2" />
          <path d="M1.5 4.7v6.4a1.6 1.6 0 0 0 1.6 1.6H7" />
          <path d="M10 12.2h4.5M12.6 10.3l1.9 1.9-1.9 1.9" />
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

/**
 * Timeline node tile: rounded square carrying the event glyph in its tone.
 * The tone and glyph default to the sent event type's.
 */
export function EventIconTile({
  type,
  size = 34,
  dashed = false,
  color = emailStatusColor(type),
  children = <EventGlyph type={type} />,
}: {
  type: string;
  size?: number;
  /** An estimate rather than a recorded event. */
  dashed?: boolean;
  color?: string | undefined;
  children?: React.ReactNode;
}) {
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
        // Dashed for a prefetch: it happened, and it does not count.
        border: `1px ${dashed || type === "prefetched" ? "dashed" : "solid"} color-mix(in srgb, ${color} 45%, var(--ms-line))`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 16%, var(--ms-panel)), color-mix(in srgb, ${color} 5%, var(--ms-panel)))`,
        color,
      }}
    >
      {children}
    </span>
  );
}

/**
 * A node on the events strip: its tile (pulsing on the newest node), the
 * label pill, the time with the UTC stamp on hover, and a mono detail line.
 * A node that opens a drawer is a button.
 */
export function EventNode({
  type,
  color = emailStatusColor(type),
  glyph,
  label,
  hint,
  at,
  detail,
  wrapDetail = false,
  latest = false,
  onClick,
}: {
  type: string;
  color?: string | undefined;
  glyph?: React.ReactNode;
  label: React.ReactNode;
  /** The pill's hover text. */
  hint?: string | undefined;
  at?: Date | string | undefined;
  detail?: React.ReactNode;
  /** Wraps the detail within its 220px instead of clipping it. */
  wrapDetail?: boolean;
  latest?: boolean;
  onClick?: (() => void) | undefined;
}) {
  const locale = useLocale();
  // Dashed for a prefetch: it happened, and it does not count.
  const prefetch = type === "prefetched";
  const body = (
    <>
      <span style={{ position: "relative", display: "inline-flex" }}>
        <EventIconTile type={type} color={color}>
          {glyph}
        </EventIconTile>
        {latest && !prefetch ? (
          <span
            className="ms-dot sm"
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              background: color,
              animation: "ms-pulse 2s infinite",
            }}
          />
        ) : null}
      </span>
      <span
        title={hint}
        style={{
          marginTop: 10,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          borderRadius: "var(--ms-r-chip)",
          border: `1px ${prefetch ? "dashed" : "solid"} color-mix(in srgb, ${color} 35%, var(--ms-line))`,
          background: `color-mix(in srgb, ${color} ${prefetch ? 4 : 10}%, var(--ms-panel))`,
          fontSize: 12,
          fontWeight: 600,
          color,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {at ? (
        <span
          title={formatUtcTimestampMs(at)}
          style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 7 }}
        >
          {formatDayTime(at, locale)}
        </span>
      ) : null}
      {detail ? (
        <span
          className="ms-mono"
          style={{
            fontSize: 11,
            color: "var(--ms-muted)",
            marginTop: 3,
            maxWidth: 220,
            whiteSpace: wrapDetail ? "normal" : "nowrap",
            ...(wrapDetail ? { overflowWrap: "anywhere" as const } : {}),
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {detail}
        </span>
      ) : null}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className="ms-events-node"
      style={{ color: "inherit", font: "inherit", cursor: "pointer" }}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className="ms-events-node">{body}</div>
  );
}

/**
 * The connector into a node: the time since the last timed node, over a line.
 * With no time to tell (an untimed node, or one listed after a later step)
 * the label stays blank, so the line keeps its height.
 */
export function EventGap({ ms, dashed = false }: { ms: number | null; dashed?: boolean }) {
  return (
    <div className="ms-events-gap">
      <span className="ms-mono" style={{ fontSize: 10.5, color: "var(--ms-muted)" }}>
        {ms !== null && ms >= 0 ? `+${formatDurationShort(ms)}` : "\u00a0"}
      </span>
      <span className={dashed ? "ms-events-line dashed" : "ms-events-line"} />
    </div>
  );
}

/** The strip while its email loads: three nodes of tile, pill and time. */
export function EventStripSkeleton() {
  return (
    <div className="ms-events">
      {[0, 1, 2].map((index) => (
        <div key={index} style={{ display: "contents" }}>
          {index > 0 ? (
            <div className="ms-events-gap">
              <span className="ms-mono" style={{ fontSize: 10.5, display: "flex" }}>
                <Skeleton width={32} height="1lh" />
              </span>
              <span className="ms-events-line" />
            </div>
          ) : null}
          <div className="ms-events-node">
            <Skeleton width={34} height={34} radius={10} />
            <span style={{ marginTop: 10, display: "flex" }}>
              <SkeletonBadge width={74} />
            </span>
            <span style={{ fontSize: 12, marginTop: 7, display: "flex" }}>
              <Skeleton width={96} height="1lh" />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
