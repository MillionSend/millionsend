"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

function CloseGlyph({ onClose }: { onClose: () => void }) {
  const t = useTranslations("common");
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t("close")}
      style={{
        background: "none",
        border: 0,
        padding: 0,
        cursor: "pointer",
        color: "var(--ms-muted)",
        fontSize: 15,
        lineHeight: 1,
      }}
    >
      ✕
    </button>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus runs on open ONLY: with onClose in its deps, an unstable arrow
  // from a call site would re-run this every render and steal focus from
  // whatever the user is typing into.
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Portaled to <body>: a modal opened from inside a stacking context (e.g.
  // the sidebar) must still paint above every sibling of that context.
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay click-to-dismiss; Esc handles keyboard
    <div
      className="ms-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ms-modal" role="dialog" aria-modal="true" ref={ref} tabIndex={-1}>
        {title ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <h2>{title}</h2>
            <CloseGlyph onClose={onClose} />
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
