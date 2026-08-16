"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/popover-menu";
import { makeMergeToken } from "@/lib/merge-fields";
import { ChevronDownIcon, SearchIcon, VariableIcon } from "./icons";

export interface PickerField {
  name: string;
  label: string;
  description: string;
  /** UNSUBSCRIBE_URL is system-generated, so it never takes a fallback. */
  allowsFallback: boolean;
}

/**
 * "Insert variable" control: a searchable list of merge fields, each with a
 * plain-language description and (where it makes sense) an optional fallback,
 * so authors never hand-type the {{{NAME|fallback}}} grammar. Selecting a field
 * inserts a Maily variable pill via `onInsert`.
 */
export function VariablePicker({
  fields,
  onInsert,
}: {
  fields: PickerField[];
  onInsert: (name: string, label: string, fallback: string | null) => void;
}) {
  const t = useTranslations("block-editor");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  /** Close and hand focus back to the trigger, so Escape never drops to body. */
  function closeToTrigger() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? fields.filter((f) => f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q))
    : fields;

  function insert(field: PickerField) {
    // Strip braces: the token grammar is {{{NAME|fallback}}} with fallback
    // [^{}]*, so a stray brace would render a malformed token the save guard
    // rejects (see lib/merge-fields.ts hasWellFormedMergeTokens).
    const fallback = field.allowsFallback
      ? (fallbacks[field.name]?.replace(/[{}]/g, "").trim() ?? "")
      : "";
    onInsert(field.name, field.label, fallback || null);
    setOpen(false);
    setQuery("");
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape-anywhere dismissal for the popover; interactive children handle their own input
    <div
      ref={rootRef}
      style={{ position: "relative" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          closeToTrigger();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ms-maily-tool ms-maily-tool-labeled"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <VariableIcon size={14} />
        {t("toolbar.variables")}
        <ChevronDownIcon size={12} />
      </button>

      {open ? (
        <div className="ms-maily-picker" role="dialog" aria-label={t("toolbar.variables")}>
          <div className="ms-maily-picker-search">
            <SearchIcon size={14} />
            <input
              ref={searchRef}
              type="text"
              placeholder={t("picker.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) insert(shown[0]);
              }}
            />
          </div>
          <div className="ms-maily-picker-list">
            {shown.length === 0 ? (
              <p className="ms-maily-picker-empty">{t("picker.empty")}</p>
            ) : (
              shown.map((field) => (
                <div key={field.name} className="ms-maily-picker-row">
                  <button
                    type="button"
                    className="ms-maily-picker-pick"
                    onClick={() => insert(field)}
                  >
                    <span className="ms-maily-picker-label">{field.label}</span>
                    <span className="ms-mono ms-maily-picker-token">
                      {makeMergeToken(field.name)}
                    </span>
                    <span className="ms-maily-picker-desc">{field.description}</span>
                  </button>
                  {field.allowsFallback ? (
                    <input
                      type="text"
                      className="ms-maily-picker-fallback ms-mono"
                      placeholder={t("picker.fallback")}
                      value={fallbacks[field.name] ?? ""}
                      onChange={(e) =>
                        setFallbacks((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") insert(field);
                      }}
                    />
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
