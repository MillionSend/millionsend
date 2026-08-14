"use client";

/**
 * Nav glyphs — path data derived from Lucide 1.31.0 (© Lucide contributors,
 * ISC license: https://lucide.dev/license), inlined so individual sub-paths
 * can carry semantic hover micro-animations (mail flap opens, gear turns…).
 * 16px default, stroke 1.4, currentColor. The PARENT nav item drives the
 * animation via `hovered`; prefers-reduced-motion disables all movement.
 */

import { motion, useReducedMotion } from "motion/react";

// --ms-ease; motion needs the raw bezier, not the CSS var.
const EASE: [number, number, number, number] = [0.25, 0, 0.15, 1];
const TR = { duration: 0.4, ease: EASE };

interface GlyphProps {
  on: boolean;
  size: number;
}

function Svg({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      {children}
    </svg>
  );
}

function EmailsGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <motion.path
        d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"
        initial={false}
        animate={{ scaleY: on ? -0.8 : 1 }}
        transition={TR}
        style={{ transformBox: "fill-box", transformOrigin: "50% 0%" }}
      />
    </Svg>
  );
}

const RADIO_WAVES = [
  { d: "M7.753 16.239a6 6 0 0 1 0-8.478", delay: 0 },
  { d: "M16.247 7.761a6 6 0 0 1 0 8.478", delay: 0 },
  { d: "M4.925 19.067a10 10 0 0 1 0-14.134", delay: 0.12 },
  { d: "M19.075 4.933a10 10 0 0 1 0 14.134", delay: 0.12 },
];

function BroadcastsGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      {RADIO_WAVES.map((wave) => (
        <motion.path
          key={wave.d}
          d={wave.d}
          initial={false}
          animate={on ? { opacity: [1, 0.2, 1] } : { opacity: 1 }}
          transition={{ ...TR, delay: wave.delay }}
        />
      ))}
      <motion.circle
        cx="12"
        cy="12"
        r="2"
        initial={false}
        animate={on ? { scale: [1, 1.3, 1] } : { scale: 1 }}
        transition={TR}
        style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
      />
    </Svg>
  );
}

const TEMPLATE_LINES = [
  { d: "M10 9H8", delay: 0 },
  { d: "M16 13H8", delay: 0.09 },
  { d: "M16 17H8", delay: 0.18 },
];

function TemplatesGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      {TEMPLATE_LINES.map((line) => (
        <motion.path
          key={line.d}
          d={line.d}
          initial={false}
          animate={on ? { pathLength: [0, 1] } : { pathLength: 1 }}
          transition={{ duration: 0.3, ease: EASE, delay: line.delay }}
        />
      ))}
    </Svg>
  );
}

function AudienceGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="7" r="4" />
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <motion.g
        initial={false}
        animate={on ? { x: [2.5, 0], opacity: [0.2, 1] } : { x: 0, opacity: 1 }}
        transition={TR}
      >
        <path d="M16 3.128a4 4 0 0 1 0 7.744" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      </motion.g>
    </Svg>
  );
}

const METRIC_BARS = [
  { d: "M8 17v-3", delay: 0 },
  { d: "M13 17V5", delay: 0.07 },
  { d: "M18 17V9", delay: 0.14 },
];

function MetricsGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      {METRIC_BARS.map((bar) => (
        <motion.path
          key={bar.d}
          d={bar.d}
          initial={false}
          animate={on ? { scaleY: [0, 1] } : { scaleY: 1 }}
          transition={{ duration: 0.35, ease: EASE, delay: bar.delay }}
          style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
        />
      ))}
    </Svg>
  );
}

function DomainsGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      {/* Meridian is symmetric about x=12, so scaleX −1 lands on the same shape: a full sweep with no visible end state. */}
      <motion.path
        d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"
        initial={false}
        animate={{ scaleX: on ? -1 : 1 }}
        transition={{ duration: 0.5, ease: EASE }}
        style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
      />
    </Svg>
  );
}

function LogsGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <motion.path
        d="m7 11 2-2-2-2"
        initial={false}
        animate={on ? { x: [0, 1.5, 0] } : { x: 0 }}
        transition={TR}
      />
      <motion.path
        d="M11 13h4"
        initial={false}
        animate={on ? { opacity: [1, 0, 1] } : { opacity: 1 }}
        transition={TR}
      />
    </Svg>
  );
}

function ApiKeysGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <motion.g
        initial={false}
        animate={on ? { rotate: [0, -14, 10, 0] } : { rotate: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
        style={{ transformBox: "view-box", transformOrigin: "16.5px 7.5px" }}
      >
        <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
        <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
      </motion.g>
    </Svg>
  );
}

function WebhooksGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <motion.g
        initial={false}
        animate={on ? { rotate: [0, -12, 0] } : { rotate: 0 }}
        transition={{ duration: 0.45, ease: EASE }}
        style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
      >
        <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
        <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
        <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
      </motion.g>
    </Svg>
  );
}

function SettingsGlyph({ on, size }: GlyphProps) {
  return (
    <Svg size={size}>
      <motion.g
        initial={false}
        animate={{ rotate: on ? 30 : 0 }}
        transition={TR}
        style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
      >
        <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
        <circle cx="12" cy="12" r="3" />
      </motion.g>
    </Svg>
  );
}

const GLYPHS = {
  emails: EmailsGlyph,
  broadcasts: BroadcastsGlyph,
  templates: TemplatesGlyph,
  audience: AudienceGlyph,
  metrics: MetricsGlyph,
  domains: DomainsGlyph,
  logs: LogsGlyph,
  "api-keys": ApiKeysGlyph,
  webhooks: WebhooksGlyph,
  settings: SettingsGlyph,
} as const;

export type NavIconName = keyof typeof GLYPHS;

export function NavGlyph({
  name,
  hovered = false,
  size = 16,
}: {
  name: NavIconName;
  hovered?: boolean;
  size?: number;
}) {
  const reduced = useReducedMotion();
  const Glyph = GLYPHS[name];
  return <Glyph on={hovered && !(reduced ?? false)} size={size} />;
}
