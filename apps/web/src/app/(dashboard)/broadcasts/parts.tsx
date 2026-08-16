"use client";

import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/skeleton";
import { escapeHtml } from "@/lib/html";
import { MERGE_TOKEN_RE } from "@/lib/merge-fields";
import { useTheme } from "@/lib/use-theme";

// Stand-in values so every merge pill reads as real content in the preview
// rather than a raw {{{TOKEN}}}. UNSUBSCRIBE_URL becomes a dead "#" — the
// worker resolves the real link at send time. Unknown names fall back to the
// author's own |fallback, then to the bare name.
const PREVIEW_SAMPLES: Record<string, string> = {
  FIRST_NAME: "Ada",
  LAST_NAME: "Lovelace",
  EMAIL: "ada@example.com",
  UNSUBSCRIBE_URL: "#",
};

/** Fill every merge token with a preview sample; `samples` supplies real
 * per-contact-property values where the caller has them. Values are
 * HTML-escaped — contact-controlled property strings must read as text in the
 * preview, never as markup. */
function fillMergeSamples(html: string, samples: Record<string, string>): string {
  return html.replace(MERGE_TOKEN_RE, (_m, name: string, fallback: string | undefined) =>
    escapeHtml(PREVIEW_SAMPLES[name] ?? samples[name] ?? fallback ?? name),
  );
}

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled";

// Pill variant per the canvas: draft and canceled stay neutral, scheduled
// warns (it will cost sends), sending informs, sent reads as done.
const PILL_VARIANT: Record<BroadcastStatus, string> = {
  draft: "neutral",
  scheduled: "warn",
  sending: "info",
  sent: "success",
  canceled: "neutral",
};

/** Broadcast status pill; "sending" carries a pulsing dot — it is the only live state. */
export function StatusPill({ status }: { status: BroadcastStatus }) {
  const t = useTranslations("broadcasts");
  return (
    <span
      className={`ms-badge ms-badge-${PILL_VARIANT[status]}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      {status === "sending" ? (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "currentColor",
            animation: "ms-pulse 2s infinite",
            flex: "none",
          }}
        />
      ) : null}
      {t(`status.${status}`)}
    </span>
  );
}

/** Uppercase microlabel over big tabular digits; the ghost keeps the digit line box. */
export function StatBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
        {label}
      </div>
      <div
        className="ms-digits"
        style={{
          fontSize: "var(--ms-fs-kpi)",
          color: "var(--ms-bone)",
          marginTop: 6,
          display: "flex",
        }}
      >
        {value ?? <Skeleton width={64} height="1lh" />}
      </div>
    </div>
  );
}

/*
 * Approximation of how dark-mode mail clients (Gmail's auto-darkening, Apple
 * Mail with supported-color-schemes) transform a light email: invert + rotate
 * hues, then re-invert media so photos and logos keep their real colors. Full
 * invert(1) both ways keeps images pixel-exact. Preview-only — nothing here
 * ships in a send.
 */
const DARK_CLIENT_SIM = `<style>
  html { filter: invert(1) hue-rotate(180deg); background: #fff; }
  img, video, [style*="background-image"] { filter: invert(1) hue-rotate(180deg); }
</style>`;

/**
 * Sandboxed render of broadcast HTML; scripts never run. Every merge token is
 * shown as a sample value so the preview reads like a real send. When the app
 * theme is dark, the preview simulates a dark-mode client instead of always
 * showing the light rendering.
 */
export function ContentPreview({
  html,
  title,
  samples = {},
}: {
  html: string;
  title: string;
  samples?: Record<string, string>;
}) {
  const dark = useTheme() === "dark";
  return (
    <div
      style={{
        background: "var(--ms-inset)",
        padding: 28,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <iframe
        title={title}
        sandbox=""
        srcDoc={fillMergeSamples(html, samples) + (dark ? DARK_CLIENT_SIM : "")}
        style={{
          width: 560,
          maxWidth: "100%",
          height: 480,
          border: 0,
          borderRadius: 8,
          background: dark ? "#111113" : "#ffffff",
        }}
      />
    </div>
  );
}
