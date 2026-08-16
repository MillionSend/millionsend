"use client";

import { useLocale, useTranslations } from "next-intl";
import { confirmDialog } from "@/components/confirm-dialog";
import { formatRelative } from "@/lib/format";

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "var(--ms-bone)",
  textDecoration: "underline dotted var(--ms-faint)",
  textUnderlineOffset: 3,
  cursor: "pointer",
};

/** Quiet one-line offer for a locally-recovered draft: restore it or throw it
 * away. Deliberately subtle — a footnote under the editor, not a banner. */
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
    <p
      role="status"
      style={{
        margin: "8px 0 0",
        fontSize: "var(--ms-fs-label)",
        color: "var(--ms-muted)",
      }}
    >
      {common("draftRecovered", { time: formatRelative(savedAt, locale) })}{" "}
      <button type="button" style={linkButtonStyle} onClick={onRestore}>
        {common("draftRestore")}
      </button>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        style={linkButtonStyle}
        onClick={() => {
          // Discarding is irreversible — the draft is the only copy.
          void confirmDialog({
            message: common("draftDiscardConfirm"),
            confirmLabel: common("draftDiscard"),
            danger: true,
          }).then((ok) => {
            if (ok) onDiscard();
          });
        }}
      >
        {common("draftDiscard")}
      </button>
    </p>
  );
}
