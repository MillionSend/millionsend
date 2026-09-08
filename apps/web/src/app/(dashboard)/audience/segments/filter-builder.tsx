"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/anchored-panel";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { FOCUSABLE } from "@/components/modal";
import { Select, type SelectOption } from "@/components/select";
import {
  BASE_FIELDS,
  type BuilderRow,
  defaultOp,
  fieldPickerValue,
  isProperty,
  type MatchMode,
  opsFor,
  PROPERTY_PREFIX,
  propertyKey,
  rowComplete,
  type SegmentFilterDraft,
  VALUELESS_OPS,
} from "@/lib/segment-builder";
import { useTRPC } from "@/lib/trpc";

/* Editor panel geometry: its width, and the space below the anchor worth
   keeping before the panel flips above it. */
const PANEL_WIDTH = 340;
const PANEL_FLIP_THRESHOLD = 420;
const MAX_SUGGESTIONS = 6;
/** The field picker's free-form entry: a property key typed by hand. */
const CUSTOM_PROPERTY = "property";

/**
 * The one editor for a condition, adding or editing: field, operator, value
 * and value suggestions in a panel anchored to the pill or the add button.
 * Portaled and fixed so the create-segment dialog, a scroll container, cannot
 * clip it; a non-modal dialog, so it runs its own Tab loop and hands focus
 * back to its anchor when it closes.
 */
function ConditionPopover({
  anchor,
  initial,
  onSubmit,
  onRemove,
  onClose,
}: {
  anchor: HTMLElement;
  /** The row being edited; null adds a new one. */
  initial: BuilderRow | null;
  onSubmit: (row: BuilderRow) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("audience.segments");
  const common = useTranslations("common");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const trpc = useTRPC();
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const style = useAnchoredPanel(anchor, {
    width: PANEL_WIDTH,
    flipThreshold: PANEL_FLIP_THRESHOLD,
  });

  const [row, setRow] = useState<BuilderRow>(
    initial ?? { field: "email", op: defaultOp("email"), value: "" },
  );
  // Set when the free-form entry is picked, so the key input stays while a
  // key is typed even once it matches a listed one.
  const [custom, setCustom] = useState(false);

  const propertiesQuery = useQuery(trpc.audience.properties.list.queryOptions());
  // A contact can carry an empty key through the API; it is no field to pick.
  const known = useMemo(
    () => (propertiesQuery.data ?? []).map((p) => p.key).filter((k) => k !== ""),
    [propertiesQuery.data],
  );
  const pickerValue = custom ? CUSTOM_PROPERTY : fieldPickerValue(row.field);
  const key = propertyKey(row.field);
  const listed = known.includes(key);
  const valueless = VALUELESS_OPS.has(row.op);

  const valuesQuery = useQuery(
    trpc.audience.properties.values.queryOptions(
      { key },
      { enabled: !valueless && key !== "" && listed, staleTime: 60_000 },
    ),
  );
  const needle = row.value.trim().toLowerCase();
  const suggestions = valueless
    ? []
    : (valuesQuery.data ?? [])
        .filter((s) => s.value !== row.value && s.value.toLowerCase().includes(needle))
        .slice(0, MAX_SUGGESTIONS);

  const fieldOptions: SelectOption[] = [
    ...BASE_FIELDS.map((f) => ({
      value: f,
      label: t(`field.${f}`),
      group: t("builder.groupContact"),
    })),
    ...known.map((k) => {
      const p = propertiesQuery.data?.find((entry) => entry.key === k);
      return {
        value: PROPERTY_PREFIX + k,
        label: k,
        group: t("builder.groupProperties"),
        ...(p && p.totalContacts > 0
          ? { hint: `${Math.round((p.contactCount / p.totalContacts) * 100)}%` }
          : {}),
      };
    }),
    // A saved key the list doesn't carry (typed by hand, or not loaded yet)
    // still shows as itself rather than as the free-form entry.
    ...(key !== "" && !listed && !custom
      ? [{ value: row.field, label: key, group: t("builder.groupProperties") }]
      : []),
    { value: CUSTOM_PROPERTY, label: t("field.property"), group: t("builder.groupProperties") },
  ];

  const pickField = (value: string) => {
    const field = value === CUSTOM_PROPERTY ? PROPERTY_PREFIX : value;
    setCustom(value === CUSTOM_PROPERTY);
    setRow({ field, op: defaultOp(field), value: "" });
  };

  useEffect(() => {
    // preventScroll: the placement's scroll listener would otherwise re-run
    // on the focus itself.
    panelRef.current?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element;
      // A Select inside the panel portals its listbox to <body>: a click
      // there is still ours.
      if (
        panelRef.current?.contains(target) ||
        anchor.contains(target) ||
        target.closest(".ms-menu")
      )
        return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [anchor, onClose]);

  // Focus returns to the anchor on close so Tab continues inside the dialog
  // (a removed pill is gone; focus then stays where the browser puts it).
  useEffect(
    () => () => {
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    },
    [anchor],
  );

  const complete = rowComplete(row);
  const apply = () => {
    if (complete) onSubmit({ ...row, value: row.value.trim() });
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Sits under the create dialog's <form> in the React tree: that form's
    // submit must not fire.
    event.stopPropagation();
    apply();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      // The dialog underneath listens on document; it must stay open.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      // ⌘↵ saves the dialog underneath; in here it applies the condition.
      event.preventDefault();
      event.stopPropagation();
      apply();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    // Outside the modal's focus trap, so Tab wraps within the panel.
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const title = initial ? t("builder.editCondition") : t("builder.addCondition");

  return createPortal(
    <div
      ref={panelRef}
      className="ms-menu"
      role="dialog"
      aria-label={title}
      style={{ ...style, padding: 14, overflowY: "auto", zIndex: "var(--ms-z-menu)" }}
      onKeyDown={onKeyDown}
    >
      <form onSubmit={submit}>
        <p className="ms-microlabel" style={{ margin: "0 0 12px", fontSize: 10.5 }}>
          {title}
        </p>
        <div className="ms-field">
          <label htmlFor={`${id}-field`}>{t("builder.fieldLabel")}</label>
          <Select
            id={`${id}-field`}
            value={pickerValue}
            ariaLabel={t("builder.fieldLabel")}
            width="100%"
            options={fieldOptions}
            onChange={pickField}
          />
          {pickerValue === CUSTOM_PROPERTY ? (
            <input
              className="ms-input mono"
              style={{ width: "100%", marginTop: 6 }}
              placeholder={t("builder.propertyKeyPlaceholder")}
              aria-label={t("builder.propertyKeyPlaceholder")}
              value={key}
              onChange={(event) => setRow({ ...row, field: PROPERTY_PREFIX + event.target.value })}
            />
          ) : null}
        </div>
        <div className="ms-field" style={{ marginTop: 12 }}>
          <label htmlFor={`${id}-op`}>{t("builder.opLabel")}</label>
          <Select
            id={`${id}-op`}
            value={row.op}
            ariaLabel={t("builder.opLabel")}
            width="100%"
            options={opsFor(row.field).map((op) => ({ value: op, label: t(`op.${op}`) }))}
            onChange={(op) => setRow({ ...row, op })}
          />
        </div>
        {valueless ? (
          <p
            style={{ margin: "12px 0 0", color: "var(--ms-faint)", fontSize: "var(--ms-fs-label)" }}
          >
            {t("builder.noValue")}
          </p>
        ) : (
          <div className="ms-field" style={{ marginTop: 12 }}>
            <label htmlFor={`${id}-value`}>{t("builder.valuePlaceholder")}</label>
            <input
              id={`${id}-value`}
              type={row.field === "created_at" ? "date" : "text"}
              className="ms-input"
              style={{ width: "100%" }}
              value={row.value}
              onChange={(event) => setRow({ ...row, value: event.target.value })}
            />
            {suggestions.length > 0 ? (
              <div style={{ margin: "6px -4px 0", display: "flex", flexDirection: "column" }}>
                {suggestions.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className="ms-menu-item"
                    onClick={() => setRow({ ...row, value: s.value })}
                  >
                    <span className="ms-mono">{s.value}</span>
                    <span className="ms-mono" style={{ color: "var(--ms-muted)", fontSize: 12 }}>
                      {nf.format(s.contactCount)}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          {onRemove ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              style={{ paddingLeft: 0 }}
              onClick={onRemove}
            >
              {t("builder.removeRow")}
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")}
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={!complete}>
            {initial ? t("builder.apply") : t("builder.add")}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** A saved condition as a pill: its text opens the editor, the ✕ removes it. */
function ConditionPill({
  row,
  open,
  onEdit,
  onRemove,
}: {
  row: BuilderRow;
  open: boolean;
  onEdit: (anchor: HTMLElement) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("audience.segments");
  const property = isProperty(row.field);
  return (
    <span className={`ms-pill${open ? " open" : ""}`}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => onEdit(event.currentTarget)}
      >
        <span className={property ? "txt" : "txt sans"}>
          {property ? propertyKey(row.field) : t(`field.${row.field}`)}
        </span>
        <span className="txt op">{t(`op.${row.op}`)}</span>
        {VALUELESS_OPS.has(row.op) ? null : <span className="txt">{row.value}</span>}
      </button>
      <button
        type="button"
        className="ms-pill-x"
        aria-label={t("builder.removeRow")}
        onClick={onRemove}
      >
        ✕
      </button>
    </span>
  );
}

/** The conditions block: match-mode chooser, condition pills, "add condition". */
export function FilterConditions({
  match,
  onMatch,
  rows,
  onRows,
}: {
  match: MatchMode;
  onMatch: (match: MatchMode) => void;
  rows: BuilderRow[];
  onRows: (rows: BuilderRow[]) => void;
}) {
  const t = useTranslations("audience.segments");
  const [editing, setEditing] = useState<{ index: number | null; anchor: HTMLElement } | null>(
    null,
  );
  const close = useCallback(() => setEditing(null), []);
  /** Clicking the open pill (or the add button) again closes its panel. */
  const toggle = (index: number | null, anchor: HTMLElement) =>
    setEditing((current) => (current?.index === index ? null : { index, anchor }));
  const adding = editing !== null && editing.index === null;

  return (
    <div className="ms-field" style={{ marginTop: 16 }}>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: group heading for the condition pills, not a single-control label */}
      <label style={{ marginBottom: 0 }}>{t("builder.conditionsLabel")}</label>
      <div
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 }}
      >
        {rows.length > 1 ? (
          <Select
            button
            value={match}
            ariaLabel={t("builder.matchLabel")}
            options={(["all", "any"] as const).map((m) => ({
              value: m,
              label: t(`builder.match.${m}`),
            }))}
            onChange={(value) => onMatch(value as MatchMode)}
          />
        ) : null}
        {rows.map((row, i) => (
          <ConditionPill
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, no stable id
            key={i}
            row={row}
            open={editing?.index === i}
            onEdit={(anchor) => toggle(i, anchor)}
            onRemove={() => {
              onRows(rows.filter((_, j) => j !== i));
              setEditing(null);
            }}
          />
        ))}
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          style={{ padding: "4px 8px" }}
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={(event) => toggle(null, event.currentTarget)}
        >
          <PlusGlyph size={13} />
          {t("builder.addCondition")}
        </button>
      </div>
      {rows.length === 0 ? (
        <p style={{ margin: "8px 0 0", color: "var(--ms-faint)", fontSize: "var(--ms-fs-label)" }}>
          {t("builder.noConditions")}
        </p>
      ) : null}
      {editing ? (
        <ConditionPopover
          // Keyed by target: switching pills remounts with that pill's draft.
          key={editing.index ?? "new"}
          anchor={editing.anchor}
          initial={editing.index === null ? null : (rows[editing.index] ?? null)}
          onClose={close}
          onSubmit={(row) => {
            onRows(
              editing.index === null
                ? [...rows, row]
                : rows.map((r, j) => (j === editing.index ? row : r)),
            );
            setEditing(null);
          }}
          {...(editing.index !== null
            ? {
                onRemove: () => {
                  onRows(rows.filter((_, j) => j !== editing.index));
                  setEditing(null);
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}

/**
 * Live "{n} contacts match" box. Debounces the filter snapshot internally so
 * each keystroke in a value input doesn't fire a count query. Hidden while
 * the filter has no complete conditions — there is nothing to preview.
 */
export function FilterCountPreview({
  filter,
  enabled = true,
}: {
  filter: SegmentFilterDraft;
  enabled?: boolean;
}) {
  const t = useTranslations("audience.segments");
  const trpc = useTRPC();

  const [debounced, setDebounced] = useState(filter);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(filter), 350);
    return () => clearTimeout(id);
  }, [filter]);

  const countQuery = useQuery(
    trpc.segments.count.queryOptions(
      { filter: debounced },
      { enabled: enabled && debounced.conditions.length > 0 },
    ),
  );

  if (filter.conditions.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 14,
        padding: "10px 14px",
        borderRadius: "var(--ms-r-input)",
        background: "var(--ms-panel-raised)",
        fontSize: "var(--ms-fs-ui)",
      }}
    >
      {countQuery.isPending ? (
        <span style={{ color: "var(--ms-muted)" }}>{t("builder.counting")}</span>
      ) : countQuery.isError ? (
        <span style={{ color: "var(--ms-danger)" }}>{t("builder.countError")}</span>
      ) : (
        t("builder.matchCount", { count: countQuery.data?.count ?? 0 })
      )}
    </div>
  );
}
