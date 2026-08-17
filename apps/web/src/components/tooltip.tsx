"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* Flip the panel below the anchor when the viewport top leaves no headroom. */
const FLIP_THRESHOLD = 96;
const ANCHOR_GAP = 8;

function CircleInfoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6.25" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="4.3" r="0.9" fill="currentColor" />
      <path d="M7 6.6v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Info tooltip — the default muted 14px circle-i trigger (or any custom
 * trigger passed as children) opening a portaled .ms-tooltip panel centered
 * above the anchor (flipping below near the viewport top, clamped inside the
 * viewport horizontally). Opens on hover and focus; click/tap toggles it
 * pinned for touch, and Esc or an outside tap dismisses. The panel is wired
 * to the trigger via aria-describedby while visible.
 */
export function Tooltip({ text, children }: { text: React.ReactNode; children?: React.ReactNode }) {
  const t = useTranslations("common");
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const open = hover || pinned;

  // Fixed-position auto width shrinks to a sliver against the right viewport
  // edge; clamp the panel's center after measuring so it stays fully visible.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = triggerRef.current;
    if (!panel || !anchor) return;
    const margin = 12;
    const half = panel.offsetWidth / 2;
    const anchorRect = anchor.getBoundingClientRect();
    const center = anchorRect.left + anchorRect.width / 2;
    const clamped = Math.min(Math.max(center, margin + half), window.innerWidth - margin - half);
    panel.style.left = `${clamped}px`;
  });

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!triggerRef.current?.contains(event.target as Node)) setPinned(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPinned(false);
        setHover(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Measured at render time: the panel is transient, so a rect from the
  // moment it opened is accurate enough — no scroll/resize tracking.
  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ms-tooltip-trigger"
        aria-label={t("info")}
        {...(open ? { "aria-describedby": panelId } : {})}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={() => setPinned((v) => !v)}
      >
        {children ?? <CircleInfoGlyph />}
      </button>
      {open && rect
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="tooltip"
              className="ms-tooltip"
              style={
                rect.top < FLIP_THRESHOLD
                  ? {
                      left: rect.left + rect.width / 2,
                      top: rect.bottom + ANCHOR_GAP,
                      transform: "translateX(-50%)",
                    }
                  : {
                      left: rect.left + rect.width / 2,
                      top: rect.top - ANCHOR_GAP,
                      transform: "translate(-50%, -100%)",
                    }
              }
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
