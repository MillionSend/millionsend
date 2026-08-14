/**
 * Empty-state tile glyphs — larger-scale statics of the nav glyph paths
 * (lucide-derived, see icons/nav-icons.tsx). Each glyph is split into 2–3
 * <g> parts so the tile CSS can drift them on a stagger; animation lives
 * entirely in components.css (.ms-empty-glyph), no JS.
 */

import type { ReactNode } from "react";

export type EmptyStateArea =
  | "emails"
  | "broadcasts"
  | "templates"
  | "audience"
  | "metrics"
  | "domains"
  | "logs"
  | "api-keys"
  | "webhooks";

const GLYPHS: Record<EmptyStateArea, ReactNode> = {
  emails: (
    <>
      <g>
        <rect x="2" y="4" width="20" height="16" rx="2" />
      </g>
      <g>
        <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      </g>
    </>
  ),
  broadcasts: (
    <>
      <g>
        <path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
        <path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
      </g>
      <g>
        <path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
        <path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
      </g>
      <g>
        <circle cx="12" cy="12" r="2" />
      </g>
    </>
  ),
  templates: (
    <>
      <g>
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      </g>
      <g>
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      </g>
      <g>
        <path d="M10 9H8" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
      </g>
    </>
  ),
  audience: (
    <>
      <g>
        <circle cx="9" cy="7" r="4" />
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      </g>
      <g>
        <path d="M16 3.128a4 4 0 0 1 0 7.744" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      </g>
    </>
  ),
  metrics: (
    <>
      <g>
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      </g>
      <g>
        <path d="M8 17v-3" />
        <path d="M18 17V9" />
      </g>
      <g>
        <path d="M13 17V5" />
      </g>
    </>
  ),
  domains: (
    <>
      <g>
        <circle cx="12" cy="12" r="10" />
      </g>
      <g>
        <path d="M2 12h20" />
      </g>
      <g>
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      </g>
    </>
  ),
  logs: (
    <>
      <g>
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      </g>
      <g>
        <path d="m7 11 2-2-2-2" />
      </g>
      <g>
        <path d="M11 13h4" />
      </g>
    </>
  ),
  "api-keys": (
    <>
      <g>
        <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      </g>
      <g>
        <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
      </g>
    </>
  ),
  // Isometric wireframe cube — the Resend-style webhook tile mark; the
  // faint group is the cube's hidden back edges.
  webhooks: (
    <>
      <g>
        <path d="M12 2.6 20 7.2v9.6L12 21.4 4 16.8V7.2Z" />
      </g>
      <g>
        <path d="M4 7.2 12 11.8l8-4.6" />
        <path d="M12 11.8v9.6" />
      </g>
      <g opacity="0.35">
        <path d="M12 2.6v9.6" />
        <path d="M12 12.2l-8 4.6" />
        <path d="M12 12.2l8 4.6" />
      </g>
    </>
  ),
};

export function EmptyStateGlyph({ area, size = 40 }: { area: EmptyStateArea; size?: number }) {
  return (
    <svg
      className="ms-empty-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[area]}
    </svg>
  );
}
