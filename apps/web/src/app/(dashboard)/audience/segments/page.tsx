"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import {
  BASE_FIELDS,
  type BuilderRow,
  buildSegmentFilter,
  defaultOp,
  isProperty,
  type MatchMode,
  opsFor,
  PROPERTY_PREFIX,
  propertyKey,
  VALUELESS_OPS,
} from "@/lib/segment-builder";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "../audience-tabs";

type DeleteTarget = { id: string; name: string };

const NEW_ROW: BuilderRow = { field: "email", op: defaultOp("email"), value: "" };

function SegmentsHead() {
  const t = useTranslations("audience.segments");
  return (
    <thead>
      <tr>
        <th style={{ width: "50%" }}>{t("name")}</th>
        <th className="right">{t("count")}</th>
        <th className="right">{t("created")}</th>
        {/* Overflow-action column — no header label. */}
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded segments table: name text, a count, time, action. */
function SegmentsSkeleton() {
  return (
    <Table>
      <SegmentsHead />
      <tbody>
        {["44%", "60%", "36%"].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td className="right">
              <Skeleton width={34} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
            <td className="right" style={{ width: 40 }}>
              <Skeleton width={22} height={30} radius="var(--ms-r-input)" />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

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

export default function SegmentsPage() {
  const t = useTranslations("audience.segments");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [match, setMatch] = useState<MatchMode>("all");
  const [rows, setRows] = useState<BuilderRow[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const query = useQuery(trpc.segments.list.queryOptions());

  // Debounced snapshot of the filter drives the live count so each keystroke in
  // a value input doesn't fire a query.
  const filter = useMemo(() => buildSegmentFilter(match, rows), [match, rows]);
  const [debounced, setDebounced] = useState(filter);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(filter), 350);
    return () => clearTimeout(id);
  }, [filter]);

  const countQuery = useQuery(
    trpc.segments.count.queryOptions({ filter: debounced }, { enabled: createOpen }),
  );

  const invalidate = () => queryClient.invalidateQueries(trpc.segments.pathFilter());
  const resetBuilder = () => {
    setName("");
    setMatch("all");
    setRows([]);
  };
  const createMutation = useMutation(
    trpc.segments.create.mutationOptions({
      onSuccess: () => {
        setCreateOpen(false);
        resetBuilder();
        invalidate();
      },
    }),
  );
  const deleteMutation = useMutation(
    trpc.segments.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        invalidate();
      },
    }),
  );

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const canSave = name.trim() !== "" && !createMutation.isPending;

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            onClick={() => {
              createMutation.reset();
              setCreateOpen(true);
            }}
          >
            <PlusGlyph size={14} />
            {t("create")}
          </button>
        }
      />
      <AudienceTabs />

      {query.isPending ? (
        <SegmentsSkeleton />
      ) : query.isError ? (
        <div
          style={{
            border: "1px solid var(--ms-line)",
            borderRadius: 16,
            padding: 22,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("loadError")}</div>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            style={{ marginTop: 12 }}
            onClick={() => query.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : query.data.length === 0 ? (
        <EmptyState
          area="audience"
          headline={t("empty")}
          body={t("emptyHint")}
          cta={
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph size={14} />
              {t("create")}
            </button>
          }
        />
      ) : (
        <Table>
          <SegmentsHead />
          <tbody>
            {query.data.map((row) => (
              <tr key={row.id}>
                <td>
                  <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>{row.name}</div>
                </td>
                <td className="right ms-mono" style={{ fontSize: 13 }}>
                  {nf.format(row.count)}
                </td>
                <td className="right" style={{ color: "var(--ms-muted)" }}>
                  <RelativeTime date={row.createdAt} />
                </td>
                <td className="right" style={{ width: 40 }}>
                  <PopoverMenu
                    ariaLabel={t("menu")}
                    items={[
                      {
                        label: t("delete"),
                        danger: true,
                        onSelect: () => setDeleteTarget({ id: row.id, name: row.name }),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={createOpen} onClose={closeCreate} title={t("createTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            createMutation.mutate({ name: name.trim(), filter });
          }}
        >
          <div className="ms-field">
            <label htmlFor="seg-name">{t("builder.nameLabel")}</label>
            <input
              id="seg-name"
              className={`ms-input${createMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("builder.namePlaceholder")}
              disabled={createMutation.isPending}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

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
                      onClick={() => setMatch(m)}
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
                    onChange={(next) => setRows((prev) => prev.map((r, j) => (j === i ? next : r)))}
                    onRemove={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))
              )}
            </div>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              style={{ marginTop: 8 }}
              onClick={() => setRows((prev) => [...prev, { ...NEW_ROW }])}
            >
              <PlusGlyph size={13} />
              {t("builder.addCondition")}
            </button>
          </div>

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

          {createMutation.isError ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("builder.saveError")}
            </p>
          ) : null}

          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={!canSave}>
              <BtnSpinner on={createMutation.isPending} />
              {t("builder.save")} <span className="ms-keycap">↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal open={deleteTarget !== null} onClose={closeDelete} title={t("deleteTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (deleteTarget && !deleteMutation.isPending) {
              deleteMutation.mutate({ id: deleteTarget.id });
            }
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("deleteBody", { name: deleteTarget?.name ?? "—" })}
          </p>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={deleteMutation.isPending}
            >
              <BtnSpinner on={deleteMutation.isPending} />
              {t("deleteConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
