"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EllipsisGlyph } from "./icons/nav-icons.js";

/** Closes an open popover when the pointer goes down outside `ref`. */
export function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [ref, open, onClose]);
}

export interface PopoverMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Right-aligned glyph, e.g. "↗" for external destinations. */
  trailing?: string;
}

const GAP = 8;

/**
 * "…" overflow menu — an EllipsisGlyph trigger opening a .ms-menu panel, per the
 * canvas dropdown grammar. Items are actions only; use <Select> for value
 * pickers. Pass `null` items to render a separator.
 *
 * The panel is portaled to <body> and positioned `fixed` from the trigger's
 * rect: a row menu lives inside the table's `overflow-x:auto` wrapper (which the
 * axis-coupling rule turns into a clip on both axes), so an in-flow absolute
 * panel would be cropped by the table edge. Fixed + portal escapes it.
 *
 * `boxed` draws the trigger as a full icon button (matching sibling buttons in a
 * detail header); the default is the bare glyph, quieter for a table row.
 */
export function PopoverMenu({
  ariaLabel,
  items,
  align = "right",
  triggerGlyph,
  boxed = false,
}: {
  ariaLabel: string;
  items: (PopoverMenuItem | null)[];
  align?: "left" | "right";
  triggerGlyph?: React.ReactNode;
  boxed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      // A click on a menu item must reach its onClick; only truly-outside
      // pointerdowns dismiss (the item handler closes the menu itself).
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    // The fixed panel is pinned to a rect captured at open; any scroll (capture
    // catches nested overflow containers) or resize detaches it, so close.
    function onReflow() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  // Read at render (the trigger is already mounted when `open` flips true), as
  // in tooltip.tsx — a menu is transient, so no scroll/resize tracking is kept.
  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined;
  let position: React.CSSProperties | undefined;
  if (rect) {
    const estHeight = items.length * 32 + 12;
    const flipUp =
      rect.bottom + GAP + estHeight > window.innerHeight &&
      rect.top > window.innerHeight - rect.bottom;
    position = {
      position: "fixed",
      ...(flipUp ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      ...(align === "right" ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      width: "max-content",
    };
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={boxed ? "ms-btn ms-btn-icon" : "ms-menu-trigger-bare"}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerGlyph ?? <EllipsisGlyph />}
      </button>
      {open && position
        ? createPortal(
            <div ref={panelRef} role="menu" className="ms-menu" style={position}>
              {items.map((item, index) =>
                item === null ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: separators are positional and static
                  <hr key={`sep-${index}`} className="ms-menu-sep" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={item.danger ? "ms-menu-item danger" : "ms-menu-item"}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                    {item.trailing ? (
                      <span style={{ color: "var(--ms-muted)" }} aria-hidden="true">
                        {item.trailing}
                      </span>
                    ) : null}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
