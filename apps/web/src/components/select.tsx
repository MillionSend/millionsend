"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDismiss } from "./popover-menu";

export interface SelectOption {
  value: string;
  label: string;
  /** Muted trailing detail shown after the label in the option row. */
  hint?: string;
  /** Leading adornment in the option row, e.g. a <StatusDot>. */
  adornment?: React.ReactNode;
}

/* Search input appears only when the list is long enough for scanning to hurt. */
const SEARCH_THRESHOLD = 10;
const TYPEAHEAD_RESET_MS = 500;
/* Popover placement: breathing room to the viewport edge, and the minimum
   below-space worth keeping before flipping the panel above the trigger. */
const VIEWPORT_MARGIN = 16;
const FLIP_THRESHOLD = 200;

/**
 * Replacement for native <select>: compact .ms-input trigger + .ms-menu
 * listbox popover, per the canvas dropdown grammar. Controlled only.
 * ARIA combobox pattern — focus stays on the trigger (or the search input
 * when present); aria-activedescendant tracks the highlighted option.
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  width,
  disabled = false,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  width?: number | string;
  disabled?: boolean;
  /** Forwarded to the trigger so an ms-field <label htmlFor> can target it. */
  id?: string;
}) {
  const t = useTranslations("common.select");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 264 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });
  const listboxId = useId();

  const searchable = options.length > SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);
  const selected = options.find((o) => o.value === value);

  useDismiss(rootRef, open, () => setOpen(false));

  // Keep the highlighted row visible while arrowing through a scrolled list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listboxId]);

  function openMenu() {
    if (disabled) return;
    setQuery("");
    const selectedIndex = options.findIndex((o) => o.value === value);
    setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex);
    // Size to the real viewport gap instead of a fixed cap: the list grows to
    // the space under the trigger, flipping above only when below is cramped
    // and above has more room. Measured on open; a resize while open is rare
    // enough that reopening is the recovery.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
      const above = rect.top - VIEWPORT_MARGIN;
      const flip = below < FLIP_THRESHOLD && above > below;
      setPlacement({ above: flip, maxHeight: Math.max(120, flip ? above : below) });
    }
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pick(next: string) {
    onChange(next);
    closeMenu();
  }

  function moveActive(delta: number) {
    if (filtered.length === 0) return;
    setActiveIndex((i) => Math.min(filtered.length - 1, Math.max(0, i + delta)));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(0, filtered.length - 1));
        break;
      case "Enter": {
        event.preventDefault();
        const option = filtered[activeIndex];
        if (option) pick(option.value);
        break;
      }
      case "Escape":
        // Do not let a parent modal's Escape handler also fire.
        event.stopPropagation();
        closeMenu();
        break;
      case "Tab":
        setOpen(false);
        break;
      default: {
        // Type-ahead only when there is no search input to type into.
        if (searchable || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey)
          return;
        const now = Date.now();
        const state = typeahead.current;
        state.buffer = now - state.at > TYPEAHEAD_RESET_MS ? event.key : state.buffer + event.key;
        state.at = now;
        const needle = state.buffer.toLowerCase();
        const hit = filtered.findIndex((o) => o.label.toLowerCase().startsWith(needle));
        if (hit >= 0) setActiveIndex(hit);
      }
    }
  }

  const activeId = filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined;

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        display: "inline-block",
        flexShrink: 0,
        ...(width !== undefined ? { width } : {}),
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        {...(id !== undefined ? { id } : {})}
        className="ms-input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        {...(activeId !== undefined && open ? { "aria-activedescendant": activeId } : {})}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          width: "100%",
          cursor: disabled ? "default" : "pointer",
          textAlign: "left",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? ""}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--ms-faint)" }}
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div
          className="ms-menu"
          style={{
            position: "absolute",
            ...(placement.above ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
            left: 0,
            minWidth: "100%",
            width: "max-content",
            maxWidth: 320,
          }}
        >
          {searchable ? (
            <input
              className="ms-menu-search"
              // Search is the typing surface while the popover is open.
              // biome-ignore lint/a11y/noAutofocus: focus moves into the popover by design, Esc restores the trigger
              autoFocus
              value={query}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              {...(activeId !== undefined ? { "aria-activedescendant": activeId } : {})}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
          ) : null}
          <div
            id={listboxId}
            role="listbox"
            style={{
              // Panel chrome around the list: 12px padding, plus the search row.
              maxHeight: placement.maxHeight - (searchable ? 52 : 12),
              overflowY: "auto",
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ padding: "7px 12px", fontSize: 13, color: "var(--ms-muted)" }}>
                {t("noResults")}
              </div>
            ) : (
              filtered.map((option, index) => (
                <button
                  key={option.value}
                  id={`${listboxId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  tabIndex={-1}
                  className={index === activeIndex ? "ms-menu-item active" : "ms-menu-item"}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(option.value)}
                >
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}
                  >
                    {option.adornment}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {option.label}
                      {option.hint !== undefined ? (
                        <span style={{ color: "var(--ms-muted)", marginLeft: 8, fontSize: 12 }}>
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {option.value === value ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
