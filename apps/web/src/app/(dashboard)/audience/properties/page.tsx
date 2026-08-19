"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "../audience-tabs";

type DeleteTarget = { id: string; key: string };
type Coverage = { contactCount: number; totalContacts: number };

function PropertiesHead() {
  const t = useTranslations("audience.properties");
  return (
    <thead>
      <tr>
        <th style={{ width: "30%" }}>{t("name")}</th>
        <th style={{ width: "12%" }}>{t("type")}</th>
        <th style={{ width: "22%" }}>{t("fallback")}</th>
        <th className="right" style={{ width: "22%" }}>
          {t("coverage")}
        </th>
        <th className="right">{t("created")}</th>
        {/* Overflow-action column — no header label. */}
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded table: mono key, type, fallback, coverage, time, action. */
function PropertiesSkeleton() {
  return (
    <Table>
      <PropertiesHead />
      <tbody>
        {["38%", "52%", "44%"].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={48} height={13} />
            </td>
            <td>
              <Skeleton width="60%" height={13} />
            </td>
            <td className="right">
              <Skeleton width={64} height={13} />
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

function MonoKey({ text }: { text: string }) {
  return (
    <span className="ms-mono" style={{ fontSize: 13, color: "var(--ms-bone)" }}>
      {text}
    </span>
  );
}

export default function PropertiesPage() {
  const t = useTranslations("audience.properties");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const pf = useMemo(() => new Intl.NumberFormat(locale, { style: "percent" }), [locale]);

  const defined = useQuery(trpc.audience.properties.defineList.queryOptions());
  const derived = useQuery(trpc.audience.properties.list.queryOptions());

  const [addOpen, setAddOpen] = useState(false);
  const [key, setKey] = useState("");
  const [fallback, setFallback] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const invalidate = () => queryClient.invalidateQueries(trpc.audience.properties.pathFilter());
  const defineMutation = useMutation(
    trpc.audience.properties.define.mutationOptions({
      onSuccess: () => {
        setAddOpen(false);
        setKey("");
        setFallback("");
        invalidate();
      },
    }),
  );
  const removeMutation = useMutation(
    trpc.audience.properties.remove.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        invalidate();
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose.
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const submitAdd = () => {
    if (defineMutation.isPending || key.trim().length === 0) return;
    defineMutation.mutate({
      key: key.trim(),
      type: "string",
      ...(fallback.trim() ? { fallbackValue: fallback.trim() } : {}),
    });
  };

  const submitDelete = () => {
    if (deleteTarget && !removeMutation.isPending) {
      removeMutation.mutate({ id: deleteTarget.id });
    }
  };

  const openAdd = (prefill = "") => {
    setKey(prefill);
    setFallback("");
    defineMutation.reset();
    setAddOpen(true);
  };

  // Coverage of the derived (in-use) keys, matched to definitions
  // case-insensitively; a key with no contact value simply has no entry.
  const coverageByKey = useMemo(() => {
    const map = new Map<string, Coverage>();
    for (const row of derived.data ?? []) {
      map.set(row.key.toLowerCase(), {
        contactCount: row.contactCount,
        totalContacts: row.totalContacts,
      });
    }
    return map;
  }, [derived.data]);

  const definedKeys = useMemo(
    () => new Set((defined.data ?? []).map((p) => p.key.toLowerCase())),
    [defined.data],
  );
  // Derived keys carrying real values but with no definition — a subtle row
  // with a quick-define affordance.
  const undefinedInUse = useMemo(
    () => (derived.data ?? []).filter((p) => !definedKeys.has(p.key.toLowerCase())),
    [derived.data, definedKeys],
  );

  const renderCoverage = (cov: Coverage | undefined) => {
    if (!cov) return <span style={{ color: "var(--ms-faint)", fontSize: 13 }}>—</span>;
    return (
      <>
        <span className="ms-mono" style={{ fontSize: 13 }}>
          {nf.format(cov.contactCount)} / {nf.format(cov.totalContacts)}
        </span>{" "}
        <span style={{ color: "var(--ms-faint)", fontSize: 12.5 }}>
          {pf.format(cov.totalContacts > 0 ? cov.contactCount / cov.totalContacts : 0)}
        </span>
      </>
    );
  };

  const definedRows = defined.data ?? [];
  const isEmpty = definedRows.length === 0 && undefinedInUse.length === 0;

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <button type="button" className="ms-btn ms-btn-primary" onClick={() => openAdd()}>
            <PlusGlyph size={14} />
            {t("add")}
          </button>
        }
      />
      <AudienceTabs />

      {defined.isPending ? (
        <PropertiesSkeleton />
      ) : defined.isError ? (
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
            onClick={() => defined.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : isEmpty ? (
        <EmptyState
          area="audience"
          headline={t("empty")}
          body={t("emptyHint")}
          cta={
            <button type="button" className="ms-btn ms-btn-primary" onClick={() => openAdd()}>
              <PlusGlyph size={14} />
              {t("add")}
            </button>
          }
        />
      ) : (
        <Table>
          <PropertiesHead />
          <tbody>
            {definedRows.map((row) => (
              <tr key={row.id}>
                <td>
                  <MonoKey text={row.key} />
                </td>
                <td style={{ color: "var(--ms-muted)", fontSize: 13 }}>
                  {row.type === "string" ? t("typeString") : row.type}
                </td>
                <td>
                  {row.fallbackValue ? (
                    <span style={{ color: "var(--ms-muted)", fontSize: 13 }}>
                      {row.fallbackValue}
                    </span>
                  ) : (
                    <span style={{ color: "var(--ms-faint)", fontSize: 13 }}>—</span>
                  )}
                </td>
                <td className="right" style={{ color: "var(--ms-muted)" }}>
                  {renderCoverage(coverageByKey.get(row.key.toLowerCase()))}
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
                        onSelect: () => setDeleteTarget({ id: row.id, key: row.key }),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
            {undefinedInUse.map((row) => (
              <tr key={`derived-${row.key}`}>
                <td>
                  <MonoKey text={row.key} />{" "}
                  <span className="ms-badge ms-badge-neutral" style={{ marginLeft: 6 }}>
                    {t("inUse")}
                  </span>
                </td>
                <td>
                  <span style={{ color: "var(--ms-faint)", fontSize: 13 }}>—</span>
                </td>
                <td>
                  <span style={{ color: "var(--ms-faint)", fontSize: 13 }}>—</span>
                </td>
                <td className="right" style={{ color: "var(--ms-muted)" }}>
                  {renderCoverage(coverageByKey.get(row.key.toLowerCase()))}
                </td>
                <td className="right">
                  <span style={{ color: "var(--ms-faint)", fontSize: 13 }}>—</span>
                </td>
                <td className="right" style={{ width: 40 }}>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    onClick={() => openAdd(row.key)}
                  >
                    {t("define")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={addOpen} onClose={closeAdd} onConfirm={submitAdd} title={t("addTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitAdd();
          }}
        >
          <div className="ms-field">
            <label htmlFor="prop-key">{t("keyLabel")}</label>
            <input
              id="prop-key"
              className={`ms-input${defineMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("keyPlaceholder")}
              disabled={defineMutation.isPending}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="prop-type">{t("typeLabel")}</label>
            {/* Only 'string' is defined today; the Select leaves room for more. */}
            <Select
              id="prop-type"
              value="string"
              onChange={() => undefined}
              ariaLabel={t("typeLabel")}
              width="100%"
              disabled={defineMutation.isPending}
              options={[{ value: "string", label: t("typeString") }]}
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="prop-fallback">{t("fallbackLabel")}</label>
            <input
              id="prop-fallback"
              className="ms-input"
              style={{ width: "100%" }}
              placeholder={t("fallbackPlaceholder")}
              disabled={defineMutation.isPending}
              value={fallback}
              onChange={(event) => setFallback(event.target.value)}
            />
          </div>
          {defineMutation.isError ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {defineMutation.error.data?.code === "CONFLICT" ? t("addExists") : t("addError")}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeAdd}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={defineMutation.isPending || key.trim().length === 0}
            >
              <BtnSpinner on={defineMutation.isPending} />
              {t("addConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        onConfirm={submitDelete}
        title={t("deleteTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitDelete();
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("deleteBody", { key: deleteTarget?.key ?? "—" })}
          </p>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={removeMutation.isPending}
            >
              <BtnSpinner on={removeMutation.isPending} />
              {t("deleteConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
