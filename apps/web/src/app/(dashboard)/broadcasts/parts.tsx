"use client";

import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/skeleton";

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

/** Sandboxed render of broadcast HTML; scripts never run, the token renders as a dead link. */
export function ContentPreview({ html, title }: { html: string; title: string }) {
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
        srcDoc={html.replaceAll("{{{UNSUBSCRIBE_URL}}}", "#")}
        style={{
          width: 560,
          maxWidth: "100%",
          height: 480,
          border: 0,
          borderRadius: 8,
          background: "#ffffff",
        }}
      />
    </div>
  );
}
