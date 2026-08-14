"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * Right-side remediation drawer: dim overlay, 440px panel on --ms-panel with
 * a strong left rule — construction per the design canvas. Esc and overlay
 * click close it.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const common = useTranslations("common");

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        animation: "ms-fade var(--ms-dur-base) var(--ms-ease)",
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: overlay click-to-close; Esc handles keyboard */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard dismissal is the Esc listener above */}
      <div
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.5)" }}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 440,
          maxWidth: "calc(100vw - 24px)",
          background: "var(--ms-panel)",
          borderLeft: "1px solid var(--ms-line-strong)",
          padding: 24,
          boxSizing: "border-box",
          overflowY: "auto",
          animation: "ms-fade var(--ms-dur-drawer) var(--ms-ease)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h2)", margin: 0, fontWeight: 500 }}
          >
            {title}
          </h3>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            style={{ padding: 0 }}
            aria-label={common("close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}
