"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EllipsisGlyph } from "./icons/nav-icons.js";

/** Closes an open popover when the pointer goes down outside `ref`. */
export function useDismiss(
  ref: React.RefObject<HTMLElement | null> | React.RefObject<HTMLElement | null>[],
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const refs = Array.isArray(ref) ? ref : [ref];
    function onPointerDown(event: PointerEvent) {
      if (!refs.some((r) => r.current?.contains(event.target as Node))) onClose();
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

  /** Close and hand focus back to the trigger (Escape / item selection). */
  const closeToTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    // The portal breaks DOM-order tabbing, so the menu pattern takes over:
    // focus moves to the first item on open (preventScroll keeps the capture
    // scroll-close below from firing on the focus itself).
    panelRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      // A click on a menu item must reach its onClick; only truly-outside
      // pointerdowns dismiss (the item handler closes the menu itself).
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    // The fixed panel is pinned to a rect captured at open; any scroll (capture
    // catches nested overflow containers) or resize detaches it, so close.
    function onReflow() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  /** Roving focus over the enabled menu items, per the WAI menu pattern. */
  function onPanelKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeToTrigger();
      return;
    }
    if (event.key === "Tab") {
      // Tab exits a menu; close so the sequence continues from the trigger.
      closeToTrigger();
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const nodes = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (nodes.length === 0) return;
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? nodes.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + nodes.length) % nodes.length
            : (current - 1 + nodes.length) % nodes.length;
    nodes[next]?.focus({ preventScroll: true });
  }

  // Read at render (the trigger is already mounted when `open` flips true), as
  // in tooltip.tsx — a menu is transient, so no scroll/resize tracking is kept.
  // Offsets resolve against the layout viewport (documentElement.client*), not
  // window.inner* — the latter includes a classic scrollbar and would shift
  // right-aligned panels by its width.
  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined;
  let position: React.CSSProperties | undefined;
  if (rect) {
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const estHeight = items.length * 32 + 12;
    const flipUp = rect.bottom + GAP + estHeight > viewportH && rect.top > viewportH - rect.bottom;
    position = {
      position: "fixed",
      ...(flipUp ? { bottom: viewportH - rect.top + GAP } : { top: rect.bottom + GAP }),
      ...(align === "right" ? { right: viewportW - rect.right } : { left: rect.left }),
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
            <div
              ref={panelRef}
              role="menu"
              className="ms-menu"
              style={position}
              onKeyDown={onPanelKeyDown}
            >
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
                      closeToTrigger();
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
