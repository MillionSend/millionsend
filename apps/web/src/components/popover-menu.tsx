"use client";

import { useEffect, useRef, useState } from "react";
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

/**
 * "…" overflow menu — 30px icon trigger opening a .ms-menu panel, per the
 * canvas dropdown grammar. Items are actions only; use <Select> for value
 * pickers. Pass `null` items to render a separator.
 */
export function PopoverMenu({
  ariaLabel,
  items,
  align = "right",
  triggerGlyph,
}: {
  ariaLabel: string;
  items: (PopoverMenuItem | null)[];
  align?: "left" | "right";
  triggerGlyph?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keydown only intercepts Escape bubbling from the trigger/menu
    <div
      ref={rootRef}
      style={{ position: "relative", display: "inline-flex" }}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="ms-btn ms-btn-icon"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerGlyph ?? <EllipsisGlyph />}
      </button>
      {open ? (
        <div
          role="menu"
          className="ms-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            [align]: 0,
            width: "max-content",
          }}
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
        </div>
      ) : null}
    </div>
  );
}
