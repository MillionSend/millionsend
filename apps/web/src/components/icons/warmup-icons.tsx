/**
 * The warm-up banners' marks, stroked in their banner's tone. The pause is
 * Lucide's circle-pause (© Lucide contributors, ISC license:
 * https://lucide.dev/license).
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
