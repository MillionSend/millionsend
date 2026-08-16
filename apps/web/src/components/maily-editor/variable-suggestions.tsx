"use client";

import type { Variable } from "@maily-to/core/extensions";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface VariableSuggestionsStrings {
  header: string;
  navigate: string;
  empty: string;
}

interface PopoverProps {
  items: Variable[];
  onSelectItem: (item: Variable) => void;
}

export interface PopoverHandle {
  moveUp: () => void;
  moveDown: () => void;
  select: () => void;
}

function BracesGlyph({ className }: { className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...(className ? { className } : {})}
    >
      <path d="M6 2.8c-2 .3-2.4 1.3-2.4 2.9 0 1.3-.2 2-1.3 2.3 1.1.3 1.3 1 1.3 2.3 0 1.6.4 2.6 2.4 2.9M10 2.8c2 .3 2.4 1.3 2.4 2.9 0 1.3.2 2 1.3 2.3-1.1.3-1.3 1-1.3 2.3 0 1.6-.4 2.6-2.4 2.9" />
    </svg>
  );
}

/**
 * Our replacement for Maily's '@' variable-suggestions popover — same
 * `{ items, onSelectItem }` props and `{ moveUp, moveDown, select }` ref
 * contract its VariableList wrapper drives, but themed with our tokens and
 * with translatable chrome (Maily hardcodes "Variables"/"Navigate").
 *
 * It mounts inside Maily's ReactRenderer, OUTSIDE the app's React tree, so it
 * must not touch next-intl context — the factory closes over the translated
 * strings instead.
 */
export function makeVariableSuggestionsPopover(strings: VariableSuggestionsStrings) {
  const Popover = forwardRef<PopoverHandle, PopoverProps>(({ items, onSelectItem }, ref) => {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Reset the highlight whenever the (query-filtered) items change, so the
    // selection can never point past the end of a shrinking list.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is keyed on the items identity, not on a value read inside
    useEffect(() => {
      setSelected(0);
      if (listRef.current) listRef.current.scrollTop = 0;
    }, [items]);

    useEffect(() => {
      listRef.current
        ?.querySelectorAll<HTMLElement>("[data-suggest-item]")
        [selected]?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    useImperativeHandle(ref, () => ({
      moveUp: () => setSelected((i) => (i + items.length - 1) % Math.max(1, items.length)),
      moveDown: () => setSelected((i) => (i + 1) % Math.max(1, items.length)),
      select: () => {
        const item = items[selected];
        if (item) onSelectItem(item);
      },
    }));

    return (
      <div className="ms-varsuggest">
        <div className="ms-varsuggest-header">
          <span>{strings.header}</span>
          <BracesGlyph />
        </div>
        <div ref={listRef} className="ms-varsuggest-list">
          {items.length === 0 ? (
            <p className="ms-varsuggest-empty">{strings.empty}</p>
          ) : (
            items.map((item, index) => (
              <button
                key={item.name}
                type="button"
                data-suggest-item
                data-active={index === selected || undefined}
                className="ms-varsuggest-item ms-mono"
                onClick={() => onSelectItem(item)}
                onMouseEnter={() => setSelected(index)}
              >
                <BracesGlyph className="ms-varsuggest-braces" />
                {item.label || item.name}
              </button>
            ))
          )}
        </div>
        <div className="ms-varsuggest-footer">
          <span className="ms-varsuggest-keys">
            <kbd>↓</kbd>
            <kbd>↑</kbd> {strings.navigate}
          </span>
          <kbd>↵</kbd>
        </div>
      </div>
    );
  });
  Popover.displayName = "MsVariableSuggestions";
  return Popover;
}
