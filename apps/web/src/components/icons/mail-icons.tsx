/**
 * Mail glyphs — thread actions, row kinds, screening verdicts and received
 * events. Path data from Lucide 1.31.0 (© Lucide contributors, ISC license:
 * https://lucide.dev/license), drawn on the nav glyphs' 24-unit frame. 14px by
 * default; a tile passes a heavier stroke so the glyph keeps the weight of the
 * 16-unit envelope and event glyphs beside it.
 */
import { Svg } from "./nav-icons";

type IconProps = { size?: number; strokeWidth?: number | undefined };

export function FolderInputIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
      <path d="M2 13h10" />
      <path d="m9 16 3-3-3-3" />
    </Svg>
  );
}

export function ArchiveIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Svg>
  );
}

/** lucide octagon-alert. */
export function SpamIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M12 16h.01" />
      <path d="M12 8v4" />
      <path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" />
    </Svg>
  );
}

/** lucide trash-2. */
export function TrashIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Svg>
  );
}

export function TagIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </Svg>
  );
}

/** A static lucide inbox; the nav's InboxesGlyph animates. */
export function InboxIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Svg>
  );
}

export function MailsIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M17 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 1-1.732" />
      <path d="m22 5.5-6.419 4.179a2 2 0 0 1-2.162 0L7 5.5" />
      <rect x="7" y="3" width="15" height="12" rx="2" />
    </Svg>
  );
}

export function AsteriskIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M12 6v12" />
      <path d="M17.196 9 6.804 15" />
      <path d="m6.804 9 10.392 6" />
    </Svg>
  );
}

export function BotIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </Svg>
  );
}

/** A static lucide users; the nav's audience glyph animates. */
export function UsersIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </Svg>
  );
}

export function BugIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M12 20v-9" />
      <path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z" />
      <path d="M14.12 3.88 16 2" />
      <path d="M21 21a4 4 0 0 0-3.81-4" />
      <path d="M21 5a4 4 0 0 1-3.55 3.97" />
      <path d="M22 13h-4" />
      <path d="M3 21a4 4 0 0 1 3.81-4" />
      <path d="M3 5a4 4 0 0 0 3.55 3.97" />
      <path d="M6 13H2" />
      <path d="m8 2 1.88 1.88" />
      <path d="M9 7.13V6a3 3 0 1 1 6 0v1.13" />
    </Svg>
  );
}

export function LockIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  );
}

export function LockOpenIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </Svg>
  );
}

export function ClockIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  );
}

const SHIELD =
  "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";

export function ShieldCheckIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d={SHIELD} />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

export function ShieldAlertIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d={SHIELD} />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Svg>
  );
}

export function ShieldHalfIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d={SHIELD} />
      <path d="M12 22V2" />
    </Svg>
  );
}

export function ScanEyeIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="1" />
      <path d="M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0" />
    </Svg>
  );
}

export function PaperclipIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
    </Svg>
  );
}

export function ReplyIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      <path d="m9 17-5-5 5-5" />
    </Svg>
  );
}

export function ForwardIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="m15 17 5-5-5-5" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </Svg>
  );
}

/** A static lucide webhook; the nav's webhooks glyph animates. */
export function WebhookIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </Svg>
  );
}

/** lucide undo-2 — Restore, out of Trash. */
export function RestoreIcon({ size = 14, strokeWidth }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Svg>
  );
}

export function XIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

export function PencilIcon({ size = 13, strokeWidth = 1.6 }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Svg>
  );
}

export function ChevronLeftIcon({ size = 14, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  );
}

export function ImageOffIcon({ size = 14, strokeWidth = 1.6 }: IconProps) {
  return (
    <Svg size={size} strokeWidth={strokeWidth}>
      <line x1="2" x2="22" y1="2" y2="22" />
      <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83" />
      <line x1="13.5" x2="6" y1="13.5" y2="21" />
      <line x1="18" x2="21" y1="12" y2="15" />
      <path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59" />
      <path d="M21 15V5a2 2 0 0 0-2-2H9" />
    </Svg>
  );
}
