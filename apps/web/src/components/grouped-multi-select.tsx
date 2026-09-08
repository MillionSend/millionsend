"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "./anchored-panel";
import { ChevronGlyph } from "./icons/nav-icons";
import { useDismiss } from "./popover-menu";

export interface GroupedOption {
  value: string;
  label: string;
  /** Group key — must match one of the `groups` keys. */
  group: string;
  /** Leading adornment in the option row, e.g. a colored dot. */
  adornment?: React.ReactNode;
  /** Stays unchecked under the "all" option: it is only ever picked by name. */
  excludedFromAll?: boolean;
  /** Muted note after the label. */
  hint?: string;
}

export interface OptionGroup {
  key: string;
  label: string;
}

/**
 * Multi-select sibling of <Select>: a searchable .ms-menu popover whose rows
 * are grouped under headers and toggle on and off (checkmark on the right),
 * with an optional "all" row at the top. The menu stays open across picks.
 * ARIA combobox pattern — focus rests on the search input; the trigger shows a
 * caller-supplied summary. Controlled: `value` is the selected option values.
 *
 * `allOption` models an "everything" toggle distinct from the value array
 * (e.g. webhook endpoints where an empty subscription list means all events):
 * while it is on, every row reads as checked, and picking one row switches
 * "all" off and narrows to just that row. `exclusive` keeps the member rows
 * unchecked under it, for a filter where "all" means "no filter" rather than
 * "each of these". A group with an empty label draws no heading.
 */
export function GroupedMultiSelect({
  value,
  onChange,
  options,
  groups,
  ariaLabel,
  summary,
  searchPlaceholder,
  noResultsLabel,
  allOption,
  width,
  disabled = false,
  id,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  options: GroupedOption[];
  groups: OptionGroup[];
  ariaLabel: string;
  /** Rendered inside the trigger — e.g. "All events" or "3 events". */
  summary: React.ReactNode;
  searchPlaceholder: string;
  noResultsLabel: string;
  allOption?: {
    label: string;
    selected: boolean;
    onToggle: (selected: boolean) => void;
    adornment?: React.ReactNode;
    exclusive?: boolean;
  };
  width?: number | string;
  disabled?: boolean;
  /** Forwarded to the trigger so an ms-field <label htmlFor> can target it. */
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissRefs = useMemo(() => [rootRef, menuRef], []);
  // Portaled and fixed under the trigger: inside a dialog (a scroll
  // container) an in-flow panel would be clipped at the dialog's edge.
  const panelStyle = useAnchoredPanel(open ? rootRef.current : null);
  const listboxId = useId();

  // Filter, then flatten in group order so keyboard nav and rendering agree.
  const orderedFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (o: GroupedOption) =>
      !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
    return groups.flatMap((g) => options.filter((o) => o.group === g.key && match(o)));
  }, [options, groups, query]);

  const allOffset = allOption ? 1 : 0;
  const rowCount = allOffset + orderedFiltered.length;

  useDismiss(dismissRefs, open, () => setOpen(false));

  // Keep the highlighted row visible while arrowing through a scrolled list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listboxId]);

  function openMenu() {
    if (disabled) return;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function toggleOption(optionValue: string) {
    if (allOption?.selected) {
      // Narrowing off "all": the picked row becomes the sole selection.
      allOption.onToggle(false);
      onChange([optionValue]);
      return;
    }
    onChange(
      value.includes(optionValue)
        ? value.filter((v) => v !== optionValue)
        : [...value, optionValue],
    );
  }

  function activate(index: number) {
    if (allOption && index === 0) {
      allOption.onToggle(!allOption.selected);
      return;
    }
    const option = orderedFiltered[index - allOffset];
    if (option) toggleOption(option.value);
  }

  function moveActive(delta: number) {
    if (rowCount === 0) return;
    setActiveIndex((i) => Math.min(rowCount - 1, Math.max(0, i + delta)));
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
        setActiveIndex(Math.max(0, rowCount - 1));
        break;
      case "Enter":
        event.preventDefault();
        activate(activeIndex);
        break;
      case "Escape":
        // Do not let a parent modal's Escape handler also fire.
        event.stopPropagation();
        closeMenu();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  const activeId = open && activeIndex < rowCount ? `${listboxId}-${activeIndex}` : undefined;
  const rowChecked = (option: GroupedOption) =>
    (allOption?.selected === true && !allOption.exclusive && !option.excludedFromAll) ||
    value.includes(option.value);

  function Row({
    index,
    checked,
    onClick,
    adornment,
    label,
    hint,
  }: {
    index: number;
    checked: boolean;
    onClick: () => void;
    adornment?: React.ReactNode;
    label: string;
    hint?: string;
  }) {
    return (
      <button
        id={`${listboxId}-${index}`}
        type="button"
        role="option"
        aria-selected={checked}
        tabIndex={-1}
        className={index === activeIndex ? "ms-menu-item active" : "ms-menu-item"}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={onClick}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
          {adornment}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
          {hint ? (
            <span style={{ color: "var(--ms-faint)", fontSize: 12, flex: "none" }}>{hint}</span>
          ) : null}
        </span>
        {checked ? <span aria-hidden="true">✓</span> : null}
      </button>
    );
  }

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
        {...(activeId !== undefined ? { "aria-activedescendant": activeId } : {})}
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
          {summary}
        </span>
        <span style={{ flexShrink: 0, display: "flex", color: "var(--ms-faint)" }}>
          <ChevronGlyph />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="ms-menu"
              style={{
                ...panelStyle,
                width: "max-content",
                maxWidth: "min(320px, calc(100vw - 32px))",
                padding: 0,
                overflow: "hidden",
                zIndex: "var(--ms-z-menu)",
              }}
            >
              <input
                className="ms-menu-search"
                style={{ width: "100%", margin: 0 }}
                // Search is the typing surface while the popover is open.
                // biome-ignore lint/a11y/noAutofocus: focus moves into the popover by design, Esc restores the trigger
                autoFocus
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                {...(activeId !== undefined ? { "aria-activedescendant": activeId } : {})}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onKeyDown}
              />
              <div
                id={listboxId}
                role="listbox"
                aria-multiselectable="true"
                aria-label={ariaLabel}
                style={{
                  // The search row takes the top of the panel's height budget.
                  maxHeight:
                    (typeof panelStyle.maxHeight === "number" ? panelStyle.maxHeight : 264) - 40,
                  overflowY: "auto",
                  padding: 4,
                  boxSizing: "border-box",
                }}
              >
                {allOption ? (
                  <Row
                    index={0}
                    checked={allOption.selected}
                    onClick={() => activate(0)}
                    {...(allOption.adornment !== undefined
                      ? { adornment: allOption.adornment }
                      : {})}
                    label={allOption.label}
                  />
                ) : null}
                {orderedFiltered.length === 0 ? (
                  <div style={{ padding: "7px 12px", fontSize: 13, color: "var(--ms-muted)" }}>
                    {noResultsLabel}
                  </div>
                ) : (
                  groups.map((group) => {
                    const rows = orderedFiltered.filter((o) => o.group === group.key);
                    if (rows.length === 0) return null;
                    return (
                      <div key={group.key}>
                        {group.label ? <div className="ms-menu-label">{group.label}</div> : null}
                        {rows.map((option) => {
                          const index = allOffset + orderedFiltered.indexOf(option);
                          return (
                            <Row
                              key={option.value}
                              index={index}
                              checked={rowChecked(option)}
                              onClick={() => activate(index)}
                              {...(option.adornment !== undefined
                                ? { adornment: option.adornment }
                                : {})}
                              {...(option.hint !== undefined ? { hint: option.hint } : {})}
                              label={option.label}
                            />
                          );
                        })}
                      </div>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
