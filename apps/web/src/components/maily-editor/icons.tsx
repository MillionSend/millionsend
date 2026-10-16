// Compact 16px toolbar glyphs for the email editor, currentColor-filled/stroked
// so they inherit the toolbar button's theme token. Kept local to the editor —
// these are only used by its toolbar.

type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {children}
    </svg>
  );
}

export function BoldIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 2.75h4a2.6 2.6 0 0 1 0 5.2h-4z" fill="currentColor" stroke="none" opacity="0" />
      <path d="M4.75 3h3.6a2.35 2.35 0 0 1 0 4.7H4.75zM4.75 7.7h4.1a2.4 2.4 0 0 1 0 4.8h-4.1z" />
    </Svg>
  );
}
export function ItalicIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.5 3H6.5M9.5 13H5.5M9.2 3 6.8 13" />
    </Svg>
  );
}
export function UnderlineIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 3v4.2a3.5 3.5 0 0 0 7 0V3M3.5 13.2h9" />
    </Svg>
  );
}
export function StrikeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8h10M11.2 5.1A3 3 0 0 0 8.4 3.2C6.6 3.2 5.3 4.2 5.3 5.6c0 1 .7 1.7 2 2.1M5.2 10.4c.3 1.4 1.6 2.3 3.3 2.3 1.9 0 3.2-1 3.2-2.5" />
    </Svg>
  );
}
export function H1Icon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 3.5v9M9 3.5v9M3 8h6M12 6.6l1.6-1v6.9" />
    </Svg>
  );
}
export function H2Icon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.6 3.5v9M8 3.5v9M2.6 8H8M11 6.5c0-1 .8-1.7 1.8-1.7s1.8.7 1.8 1.7c0 1.7-3.6 2.9-3.6 5.3h3.7" />
    </Svg>
  );
}
export function BulletListIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 4.5h8M6 8h8M6 11.5h8" />
      <circle cx="3" cy="4.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function OrderedListIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 4.5h7.5M6.5 8h7.5M6.5 11.5h7.5M2 3.2h1v2.6M1.7 5.9h1.7M2 8.4h1.4l-1.5 1.7h1.6" />
    </Svg>
  );
}
export function AlignLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4h11M2.5 7.3h7M2.5 10.6h9" />
    </Svg>
  );
}
export function AlignCenterIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4h11M4.5 7.3h7M3.5 10.6h9" />
    </Svg>
  );
}
export function AlignRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4h11M6.5 7.3h7M4.5 10.6h9" />
    </Svg>
  );
}
export function LinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 9.5 9.5 6.5M7 4.8l.9-.9a2.4 2.4 0 0 1 3.4 3.4l-.9.9M9 11.2l-.9.9a2.4 2.4 0 0 1-3.4-3.4l.9-.9" />
    </Svg>
  );
}
export function ClearFormatIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 3.5h8M8.5 3.5 6 12.5M3 13.5l3-3M6 13.5l-3-3" />
    </Svg>
  );
}
export function VariableIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 2.8c-2 .3-2.4 1.3-2.4 2.9 0 1.3-.2 2-1.3 2.3 1.1.3 1.3 1 1.3 2.3 0 1.6.4 2.6 2.4 2.9M10 2.8c2 .3 2.4 1.3 2.4 2.9 0 1.3.2 2 1.3 2.3-1.1.3-1.3 1-1.3 2.3 0 1.6-.4 2.6-2.4 2.9" />
    </Svg>
  );
}
export function ChevronDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6.5 8 10l4-3.5" />
    </Svg>
  );
}
export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="3.6" />
      <path d="M10 10l3 3" />
    </Svg>
  );
}
