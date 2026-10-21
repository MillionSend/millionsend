/**
 * The warm-up and daily limit banners' marks, stroked in their banner's tone.
 * The pause and the hourglass are Lucide's circle-pause and hourglass
 * (© Lucide contributors, ISC license: https://lucide.dev/license).
 */

export function PauseIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ms-danger)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M10 15V9" />
      <path d="M14 15V9" />
    </svg>
  );
}

/** Three level lines: the day's volume held or cut. */
export function HoldIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ms-warn)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M5 7h14" />
      <path d="M5 17h14" />
    </svg>
  );
}

/** An hourglass: mail waiting out a daily limit. */
export function HourglassIcon({
  size = 17,
  strokeWidth = 2,
  color = "var(--ms-warn)",
}: {
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}
