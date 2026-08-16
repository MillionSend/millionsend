"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatRelative } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";

/** Offer bar for a locally-recovered draft: restore it or throw it away. */
export function DraftBanner({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const common = useTranslations("common");
  const locale = useLocale();
  return (
    <div
      role="status"
      className="ms-wrap-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        backgroundColor: "var(--ms-ground)",
        backgroundImage: statusGlow("warn", 14),
        border: "1px solid var(--ms-warn-border)",
        borderRadius: 12,
        padding: "10px 16px",
        marginBottom: 18,
        maxWidth: 720,
      }}
    >
      <p style={{ margin: 0, flex: 1, fontSize: "var(--ms-fs-ui)", color: "var(--ms-bone)" }}>
        {common("draftRecovered", { time: formatRelative(savedAt, locale) })}
      </p>
      <button type="button" className="ms-btn ms-btn-secondary" onClick={onDiscard}>
        {common("draftDiscard")}
      </button>
      <button type="button" className="ms-btn ms-btn-primary" onClick={onRestore}>
        {common("draftRestore")}
      </button>
    </div>
  );
}
