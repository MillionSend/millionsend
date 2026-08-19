"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Select } from "@/components/select";
import {
  BASE_FIELDS,
  type BuilderRow,
  defaultOp,
  isProperty,
  type MatchMode,
  opsFor,
  PROPERTY_PREFIX,
  propertyKey,
  type SegmentFilterDraft,
  VALUELESS_OPS,
} from "@/lib/segment-builder";
import { useTRPC } from "@/lib/trpc";

const NEW_ROW: BuilderRow = { field: "email", op: defaultOp("email"), value: "" };

/** One condition row: field / operator / value, contextual to the field kind. */
function ConditionEditor({
  row,
  onChange,
  onRemove,
}: {
  row: BuilderRow;
  onChange: (next: BuilderRow) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("audience.segments");
  const fieldValue = isProperty(row.field) ? "property" : row.field;
  const valueless = VALUELESS_OPS.has(row.op);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <div style={{ flex: "0 0 34%" }}>
        <Select
          value={fieldValue}
          ariaLabel={t("builder.fieldLabel")}
          width="100%"
          onChange={(value) => {
            const field = value === "property" ? PROPERTY_PREFIX + propertyKey(row.field) : value;
            onChange({ field, op: defaultOp(field), value: "" });
          }}
          options={[
            ...BASE_FIELDS.map((f) => ({ value: f, label: t(`field.${f}`) })),
            { value: "property", label: t("field.property") },
          ]}
        />
        {isProperty(row.field) ? (
          <input
            className="ms-input"
            style={{ width: "100%", marginTop: 6 }}
            placeholder={t("builder.propertyKeyPlaceholder")}
            value={propertyKey(row.field)}
            onChange={(event) => onChange({ ...row, field: PROPERTY_PREFIX + event.target.value })}
          />
        ) : null}
      </div>
      <div style={{ flex: "0 0 30%" }}>
        <Select
          value={row.op}
          ariaLabel={t("builder.opLabel")}
          width="100%"
          onChange={(op) => onChange({ ...row, op })}
          options={opsFor(row.field).map((op) => ({ value: op, label: t(`op.${op}`) }))}
        />
      </div>
      <div style={{ flex: 1 }}>
        {valueless ? (
          <div
            style={{
              height: 38,
              display: "flex",
              alignItems: "center",
              color: "var(--ms-faint)",
              fontSize: "var(--ms-fs-label)",
            }}
          >
            {t("builder.noValue")}
          </div>
        ) : row.field === "created_at" ? (
          <input
            type="date"
            className="ms-input"
            style={{ width: "100%" }}
            value={row.value}
            onChange={(event) => onChange({ ...row, value: event.target.value })}
          />
        ) : (
          <input
            className="ms-input"
            style={{ width: "100%" }}
            placeholder={t("builder.valuePlaceholder")}
            value={row.value}
            onChange={(event) => onChange({ ...row, value: event.target.value })}
          />
        )}
      </div>
      <button
        type="button"
        className="ms-btn ms-btn-ghost"
        aria-label={t("builder.removeRow")}
        style={{ padding: "0 10px", height: 38 }}
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

/** The conditions block: match-mode tabs, condition rows, "add condition". */
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
  return (
    <div className="ms-field" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: group heading for the condition rows, not a single-control label */}
        <label style={{ marginBottom: 0 }}>{t("builder.conditionsLabel")}</label>
        {rows.length > 1 ? (
          <div className="ms-tabs" style={{ marginBottom: 0 }}>
            {(["all", "any"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={match === m ? "active" : ""}
                onClick={() => onMatch(m)}
              >
                {t(`builder.match.${m}`)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {rows.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ms-faint)", fontSize: "var(--ms-fs-label)" }}>
            {t("builder.noConditions")}
          </p>
        ) : (
          rows.map((row, i) => (
            <ConditionEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, no stable id
              key={i}
              row={row}
              onChange={(next) => onRows(rows.map((r, j) => (j === i ? next : r)))}
              onRemove={() => onRows(rows.filter((_, j) => j !== i))}
            />
          ))
        )}
      </div>
      <button
        type="button"
        className="ms-btn ms-btn-ghost"
        style={{ marginTop: 8 }}
        onClick={() => onRows([...rows, { ...NEW_ROW }])}
      >
        <PlusGlyph size={13} />
        {t("builder.addCondition")}
      </button>
    </div>
  );
}

/**
 * Live "{n} contacts match" box. Debounces the filter snapshot internally so
 * each keystroke in a value input doesn't fire a count query.
 */
export function FilterCountPreview({
  filter,
  enabled = true,
}: {
  filter: SegmentFilterDraft;
  enabled?: boolean;
}) {
  const t = useTranslations("audience.segments");
  const locale = useLocale();
  const trpc = useTRPC();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [debounced, setDebounced] = useState(filter);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(filter), 350);
    return () => clearTimeout(id);
  }, [filter]);

  const countQuery = useQuery(trpc.segments.count.queryOptions({ filter: debounced }, { enabled }));

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
        t("builder.matchCount", { count: nf.format(countQuery.data?.count ?? 0) })
      )}
    </div>
  );
}
