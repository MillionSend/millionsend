"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loopTab } from "@/lib/keyboard";
import { PANEL_MAX_WIDTH } from "@/lib/panel-placement";
import { useAnchoredPanel } from "./anchored-panel";
import { PencilIcon } from "./icons/mail-icons";
import { ChevronGlyph, PlusGlyph } from "./icons/nav-icons";
import { useDismiss } from "./popover-menu";

/**
 * A button trigger is narrower than its panel's search placeholder; at this
 * width the placeholder fits and typing a name doesn't widen the panel.
 */
const BUTTON_PANEL_MIN_WIDTH = 250;

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
 *
 * With `onCreate`, a search that names no option exactly ends the list with a
 * row that creates it (`createLabel` words that row); Enter reaches it like
 * any row. `createExtra` adds controls under that row (how the new option is
 * made); while the panel holds controls besides the search, Tab cycles
 * through them instead of leaving.
 *
 * With `renderEdit`, the hovered or arrowed-to row shows a pencil, and → on
 * it (past the end of the typed text) does the same: the panel swaps to the
 * row's edit view until it calls `back`, or Esc.
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
  button = false,
  onCreate,
  createLabel,
  createExtra,
  editLabel,
  renderEdit,
  panelMinWidth,
  maxLength,
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
  /** Trigger drawn as a secondary button instead of an input, as Select's. */
  button?: boolean;
  /** A returned promise keeps the name typed until it settles, and after a refusal, so the reason can show beside it. */
  onCreate?: (name: string) => unknown;
  createLabel?: (name: string) => string;
  /** Controls under the create row; `create` runs the row, as Enter on it does. */
  createExtra?: (name: string, create: () => void) => React.ReactNode;
  /** The pencil's title. */
  editLabel?: string;
  renderEdit?: (option: GroupedOption, back: () => void) => React.ReactNode;
  /** Overrides the button trigger's panel width floor, for rows or controls wider than a name. */
  panelMinWidth?: number;
  /** Caps the search text, and so the longest name the create row offers. */
  maxLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissRefs = useMemo(() => [rootRef, menuRef], []);
  // Portaled and fixed under the trigger: inside a dialog (a scroll
  // container) an in-flow panel would be clipped at the dialog's edge.
  const panelStyle = useAnchoredPanel(open ? rootRef.current : null, menuRef, {
    onAnchorHidden: () => setOpen(false),
  });
  const listboxId = useId();

  // Filter, then flatten in group order so keyboard nav and rendering agree.
  const orderedFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (o: GroupedOption) =>
      !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
    return groups.flatMap((g) => options.filter((o) => o.group === g.key && match(o)));
  }, [options, groups, query]);

  const allOffset = allOption ? 1 : 0;
  const typed = query.trim();
  const creatable =
    onCreate !== undefined &&
    typed !== "" &&
    !options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const createIndex = allOffset + orderedFiltered.length;
  const rowCount = createIndex + (creatable ? 1 : 0);
  const editingOption =
    renderEdit && editing !== null ? options.find((o) => o.value === editing) : undefined;

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
    setEditing(null);
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
    if (creatable && index === createIndex) {
      if (creating) return;
      const name = typed;
      // Clears the search, unless it moved on while the create was in flight.
      const clear = () => {
        setQuery((q) => (q.trim() === name ? "" : q));
        setActiveIndex(0);
      };
      const created = onCreate?.(name);
      if (created instanceof Promise) {
        setCreating(true);
        created.then(clear, () => {}).finally(() => setCreating(false));
      } else {
        clear();
      }
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
      case "ArrowRight": {
        const option = orderedFiltered[activeIndex - allOffset];
        const field = event.currentTarget;
        // Inside the typed text, → moves the caret.
        const atEnd =
          !(field instanceof HTMLInputElement) || field.selectionStart === field.value.length;
        if (renderEdit && option && atEnd) {
          event.preventDefault();
          setEditing(option.value);
        }
        break;
      }
      case "Escape":
        // Do not let a parent modal's Escape handler also fire.
        event.stopPropagation();
        closeMenu();
        break;
      case "Tab":
        if (!loopTab(event, menuRef.current)) setOpen(false);
        break;
      default:
        break;
    }
  }

  /** Keys in the panel's other controls (a create row's extras, an edit view): Esc steps back out. */
  function onControlsKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Tab") {
      loopTab(event, menuRef.current);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      if (editingOption) setEditing(null);
      else closeMenu();
    }
  }

  const panelMax = typeof panelStyle.maxHeight === "number" ? panelStyle.maxHeight : 264;
  const activeId =
    open && !editingOption && activeIndex < rowCount ? `${listboxId}-${activeIndex}` : undefined;
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
    edit,
  }: {
    index: number;
    checked: boolean;
    onClick: () => void;
    adornment?: React.ReactNode;
    label: string;
    hint?: string;
    edit?: () => void;
  }) {
    const check = checked ? <span aria-hidden="true">✓</span> : null;
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
        {edit && index === activeIndex ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {check}
            {/* Hidden from assistive tech: an option holds no button, and → opens the same view. */}
            <span
              className="ms-menu-edit"
              title={editLabel}
              aria-hidden="true"
              onClick={(event) => {
                event.stopPropagation();
                edit();
              }}
            >
              <PencilIcon />
            </span>
          </span>
        ) : (
          check
        )}
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
        className={button ? "ms-btn ms-btn-secondary" : "ms-input"}
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
          <ChevronGlyph direction={open ? "up" : "down"} />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="ms-menu"
              style={{
                ...panelStyle,
                ...(button ? { minWidth: panelMinWidth ?? BUTTON_PANEL_MIN_WIDTH } : {}),
                width: "max-content",
                maxWidth: `min(320px, ${PANEL_MAX_WIDTH})`,
                padding: 0,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                zIndex: "var(--ms-z-menu)",
              }}
            >
              {editingOption && renderEdit ? (
                // biome-ignore lint/a11y/noStaticElementInteractions: keydown only keeps Tab in the view and takes Esc back to the list
                <div style={{ minHeight: 0, overflowY: "auto" }} onKeyDown={onControlsKeyDown}>
                  {renderEdit(editingOption, () => setEditing(null))}
                </div>
              ) : (
                <>
                  <input
                    className="ms-menu-search"
                    style={{ width: "100%", margin: 0 }}
                    // Search is the typing surface while the popover is open.
                    // biome-ignore lint/a11y/noAutofocus: focus moves into the popover by design, Esc restores the trigger
                    autoFocus
                    value={query}
                    maxLength={maxLength}
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
                      maxHeight: panelMax - 40,
                      // Gives way first when a create row's extras need the room.
                      minHeight: 0,
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
                    {orderedFiltered.length === 0 && !creatable ? (
                      <div style={{ padding: "7px 12px", fontSize: 13, color: "var(--ms-muted)" }}>
                        {noResultsLabel}
                      </div>
                    ) : (
                      groups.map((group) => {
                        const rows = orderedFiltered.filter((o) => o.group === group.key);
                        if (rows.length === 0) return null;
                        return (
                          <div key={group.key}>
                            {group.label ? (
                              <div className="ms-menu-label">{group.label}</div>
                            ) : null}
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
                                  {...(renderEdit ? { edit: () => setEditing(option.value) } : {})}
                                  label={option.label}
                                />
                              );
                            })}
                          </div>
                        );
                      })
                    )}
                    {creatable ? (
                      <>
                        {/* A listbox holds only options: a div, not a separator <hr>. */}
                        {createIndex > 0 ? <div className="ms-menu-sep" /> : null}
                        <Row
                          index={createIndex}
                          checked={false}
                          onClick={() => activate(createIndex)}
                          adornment={
                            <span style={{ display: "flex", color: "var(--ms-muted)" }}>
                              <PlusGlyph size={12} />
                            </span>
                          }
                          label={createLabel ? createLabel(typed) : typed}
                        />
                      </>
                    ) : null}
                  </div>
                  {creatable && createExtra ? (
                    // biome-ignore lint/a11y/noStaticElementInteractions: keydown only keeps Tab in the panel and Esc closing it
                    <div onKeyDown={onControlsKeyDown}>
                      {createExtra(typed, () => activate(createIndex))}
                    </div>
                  ) : null}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
