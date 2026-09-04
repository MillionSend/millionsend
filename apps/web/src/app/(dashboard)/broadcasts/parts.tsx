"use client";

import { useTranslations } from "next-intl";
import { PreviewSchemePills } from "@/components/preview-scheme-pills";
import type { TONE_COLOR } from "@/components/status-tile";
import { emulateEmailScheme } from "@/lib/email-preview";
import { escapeHtml } from "@/lib/html";
import { MERGE_TOKEN_RE } from "@/lib/merge-fields";
import { usePreviewScheme } from "@/lib/use-preview-scheme";

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
export const PILL_VARIANT: Record<BroadcastStatus, keyof typeof TONE_COLOR> = {
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

/**
 * Sandboxed render of broadcast HTML; scripts never run. Every merge token is
 * shown as a sample value so the preview reads like a real send. The frame
 * runs edge to edge like the email detail's, with the same light/dark client
 * pills, following the dashboard's theme until the author picks one.
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
  const [scheme, setScheme] = usePreviewScheme();
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "8px 12px",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <PreviewSchemePills scheme={scheme} onChange={setScheme} />
      </div>
      <iframe
        title={title}
        sandbox=""
        srcDoc={emulateEmailScheme(fillMergeSamples(html, samples), scheme)}
        style={{
          display: "block",
          width: "100%",
          height: 560,
          border: 0,
          background: scheme === "dark" ? "#111113" : "#ffffff",
        }}
      />
    </div>
  );
}
