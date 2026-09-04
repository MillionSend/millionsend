"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ANCHOR_GAP = 8;

export function CircleInfoGlyph() {
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
 *
 * `inline` swaps the button for a focusable <span> that only opens on
 * hover/focus — for passive content such as a time inside a clickable row,
 * where a click must keep falling through to the row.
 */
export function Tooltip({
  text,
  children,
  inline = false,
}: {
  text: React.ReactNode;
  children?: React.ReactNode;
  inline?: boolean;
}) {
  const t = useTranslations("common");
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const open = hover || pinned;

  // Placed after measuring: fixed-position auto width shrinks to a sliver
  // against the right viewport edge, so the center is clamped back into view;
  // and the panel sits above the anchor unless its measured height would run
  // past the viewport top, in which case it hangs below instead.
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
    const above = anchorRect.top - ANCHOR_GAP - panel.offsetHeight >= margin;
    panel.style.top = `${above ? anchorRect.top - ANCHOR_GAP : anchorRect.bottom + ANCHOR_GAP}px`;
    panel.style.transform = above ? "translate(-50%, -100%)" : "translateX(-50%)";
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

  const setTrigger = (el: HTMLElement | null) => {
    triggerRef.current = el;
  };
  const hoverProps = {
    ...(open ? { "aria-describedby": panelId } : {}),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setHover(true),
    onBlur: () => setHover(false),
  };

  return (
    <>
      {inline ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus is how keyboard users reach the stamp; a button here would swallow the row's click
        <span ref={setTrigger} className="ms-tooltip-trigger inline" tabIndex={0} {...hoverProps}>
          {children}
        </span>
      ) : (
        <button
          ref={setTrigger}
          type="button"
          className="ms-tooltip-trigger"
          aria-label={t("info")}
          {...hoverProps}
          onClick={() => setPinned((v) => !v)}
        >
          {children ?? <CircleInfoGlyph />}
        </button>
      )}
      {open && rect
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="tooltip"
              className="ms-tooltip"
              // First-paint guess; the layout effect measures and corrects it before paint.
              style={{
                left: rect.left + rect.width / 2,
                top: rect.top - ANCHOR_GAP,
                transform: "translate(-50%, -100%)",
              }}
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
