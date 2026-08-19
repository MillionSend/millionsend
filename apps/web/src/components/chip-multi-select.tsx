"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useDismiss } from "./popover-menu";

/**
 * Token input: selected options render as removable chips inside one
 * input-styled frame, and typing filters the remaining options into an
 * .ms-menu suggestion list. Enter/click adds, Backspace on an empty input
 * removes the last chip. Controlled: `value` is the selected option values.
 */
export function ChipMultiSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  removeLabel,
  disabled = false,
  id,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  ariaLabel: string;
  /** aria-label for a chip's remove button, given the chip's label. */
  removeLabel: (label: string) => string;
  disabled?: boolean;
  /** Forwarded to the text input so an ms-field <label htmlFor> can target it. */
  id?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const chips = value
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is { value: string; label: string } => o !== undefined);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => !value.includes(o.value) && o.label.toLowerCase().includes(q));
  }, [options, value, query]);

  useDismiss(rootRef, open, () => setOpen(false));

  function add(optionValue: string) {
    onChange([...value, optionValue]);
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }

  function remove(optionValue: string) {
    onChange(value.filter((v) => v !== optionValue));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.min(suggestions.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Enter": {
        // Never let Enter submit the surrounding form from inside the token input.
        event.preventDefault();
        const pick = suggestions[activeIndex];
        if (open && pick) add(pick.value);
        break;
      }
      case "Escape":
        if (open) {
          // Do not let a parent modal's Escape handler also fire.
          event.stopPropagation();
          setOpen(false);
        }
        break;
      case "Backspace": {
        const last = value[value.length - 1];
        if (query === "" && last !== undefined) remove(last);
        break;
      }
      default:
        break;
    }
  }

  const showMenu = open && suggestions.length > 0 && !disabled;
  const activeId = showMenu ? `${listboxId}-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click just forwards focus to the input inside */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users focus the inner input directly; the click only forwards focus */}
      <div
        className="ms-input"
        onClick={() => inputRef.current?.focus()}
        style={{
          height: "auto",
          minHeight: 30,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          cursor: disabled ? "default" : "text",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {chips.map((chip) => (
          <span key={chip.value} className="ms-chip">
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {chip.label}
            </span>
            <button
              type="button"
              aria-label={removeLabel(chip.label)}
              disabled={disabled}
              onClick={() => remove(chip.value)}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          {...(id !== undefined ? { id } : {})}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={showMenu}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          {...(activeId !== undefined ? { "aria-activedescendant": activeId } : {})}
          disabled={disabled}
          value={query}
          placeholder={chips.length === 0 ? placeholder : ""}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            minWidth: 80,
            border: 0,
            outline: "none",
            background: "none",
            color: "var(--ms-bone)",
            font: "400 var(--ms-fs-ui) var(--ms-font-sans)",
            padding: "2px 0",
          }}
        />
      </div>
      {showMenu ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="ms-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: "100%",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {suggestions.map((option, index) => (
            <button
              key={option.value}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={false}
              tabIndex={-1}
              className={index === activeIndex ? "ms-menu-item active" : "ms-menu-item"}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => add(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
