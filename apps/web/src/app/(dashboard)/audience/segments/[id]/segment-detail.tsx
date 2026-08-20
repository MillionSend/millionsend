"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import {
  type BuilderRow,
  buildSegmentFilter,
  filterToRows,
  type MatchMode,
  sameFilter,
} from "@/lib/segment-builder";
import { useTRPC } from "@/lib/trpc";
import { FilterConditions, FilterCountPreview } from "../filter-builder";

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
        {label}
      </p>
      <div style={{ marginTop: 4, fontSize: 14, color: "var(--ms-bone)" }}>{children}</div>
    </div>
  );
}

export function SegmentDetail({ id }: { id: string }) {
  const t = useTranslations("audience.segments");
  const tabs = useTranslations("audience.tabs");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [draft, setDraft] = useState<{ match: MatchMode; rows: BuilderRow[] } | null>(null);
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const query = useQuery(trpc.segments.get.queryOptions({ id }));

  const invalidate = () => queryClient.invalidateQueries(trpc.segments.pathFilter());
  const updateMutation = useMutation(
    trpc.segments.update.mutationOptions({
      onSuccess: () => {
        // Re-seed the builder from the refetched filter so incomplete rows the
        // save dropped don't linger as phantom edits.
        setDraft(null);
        invalidate();
      },
    }),
  );
  const renameMutation = useMutation(
    trpc.segments.update.mutationOptions({
      onSuccess: () => {
        setRenameTo(null);
        invalidate();
      },
    }),
  );
  const deleteMutation = useMutation(
    trpc.segments.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        router.push("/audience/segments");
      },
    }),
  );

  const closeRename = useCallback(() => setRenameTo(null), []);
  const closeDelete = useCallback(() => setConfirmingDelete(false), []);

  const savedFilter = query.data?.filter ?? null;
  const match = draft?.match ?? savedFilter?.match ?? "all";
  const rows = useMemo(() => draft?.rows ?? filterToRows(savedFilter), [draft, savedFilter]);
  const currentFilter = useMemo(() => buildSegmentFilter(match, rows), [match, rows]);
  const dirty = savedFilter !== null && !sameFilter(currentFilter, savedFilter);

  const submitFilter = () => {
    if (!dirty || updateMutation.isPending) return;
    updateMutation.mutate({ id, filter: currentFilter });
  };

  const submitRename = () => {
    if (renameTo === null || renameTo.trim() === "" || renameMutation.isPending) return;
    renameMutation.mutate({ id, name: renameTo.trim() });
  };

  const submitDelete = () => {
    if (deleteMutation.isPending) return;
    deleteMutation.mutate({ id });
  };

  if (query.isError) {
    return (
      <div
        className="ms-card"
        style={{ padding: 24, display: "flex", gap: 14, alignItems: "center" }}
      >
        <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)" }}>{t("detail.error")}</p>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={() => query.refetch()}>
          {t("retry")}
        </button>
      </div>
    );
  }

  if (!query.isSuccess) {
    // Mirrors the loaded page's containers (breadcrumb + H1, meta strip) so
    // nothing shifts when data lands.
    return (
      <>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
            <Skeleton width={140} height="1lh" />
          </div>
          <h1
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", margin: 0, display: "flex" }}
          >
            <Skeleton width={280} height="1lh" />
          </h1>
        </div>
        <div
          className="ms-meta-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 22,
            padding: "20px 0",
            borderTop: "1px solid var(--ms-line)",
            borderBottom: "1px solid var(--ms-line)",
            maxWidth: 1000,
          }}
        >
          <MetaItem label={t("detail.id")}>
            <Skeleton width={220} height={14} />
          </MetaItem>
          <MetaItem label={t("count")}>
            <Skeleton width={60} height={14} />
          </MetaItem>
          <MetaItem label={t("unsubscribed")}>
            <Skeleton width={60} height={14} />
          </MetaItem>
          <MetaItem label={t("detail.type")}>
            <Skeleton width={60} height={14} />
          </MetaItem>
          <MetaItem label={t("created")}>
            <Skeleton width={110} height={14} />
          </MetaItem>
        </div>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        title={data.name}
        breadcrumb={
          <>
            <Crumb href="/audience/segments" label={tabs("segments")} />
            <CrumbEnd label={t("detail.eyebrow")} />
          </>
        }
        actions={
          <>
            <Link href={`/audience?segment=${data.id}`} className="ms-btn ms-btn-secondary">
              {t("detail.viewContacts")}
            </Link>
            <PopoverMenu
              boxed
              ariaLabel={t("detail.moreActions")}
              items={[
                {
                  label: t("detail.rename"),
                  onSelect: () => {
                    renameMutation.reset();
                    setRenameTo(data.name);
                  },
                },
                null,
                {
                  label: t("delete"),
                  danger: true,
                  onSelect: () => {
                    deleteMutation.reset();
                    setConfirmingDelete(true);
                  },
                },
              ]}
            />
          </>
        }
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          maxWidth: 1000,
        }}
      >
        <MetaItem label={t("detail.id")}>
          <CopyChip value={data.id} />
        </MetaItem>
        <MetaItem label={t("count")}>
          <span className="ms-mono">{nf.format(data.count)}</span>
        </MetaItem>
        <MetaItem label={t("unsubscribed")}>
          <span className="ms-mono">{nf.format(data.unsubscribedCount)}</span>
        </MetaItem>
        <MetaItem label={t("detail.type")}>
          {data.filter === null ? t("detail.typeManual") : t("detail.typeFilter")}
        </MetaItem>
        <MetaItem label={t("created")}>
          <RelativeTime date={data.createdAt} />
        </MetaItem>
      </div>

      <section style={{ marginTop: 26, maxWidth: 720 }}>
        <h2 className="ms-display" style={{ fontSize: 22, margin: 0, color: "var(--ms-bone)" }}>
          {data.filter === null ? t("detail.manualTitle") : t("detail.filterTitle")}
        </h2>
        {data.filter === null ? (
          <p style={{ margin: "12px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("detail.manualBody")}
          </p>
        ) : (
          <div style={{ marginTop: 6 }}>
            <FilterConditions
              match={match}
              onMatch={(next) => setDraft({ match: next, rows })}
              rows={rows}
              onRows={(next) => setDraft({ match, rows: next })}
            />
            <FilterCountPreview filter={currentFilter} />
            {updateMutation.isError ? (
              <p className="ms-field-error">{t("builder.saveError")}</p>
            ) : null}
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={!dirty || updateMutation.isPending}
                onClick={submitFilter}
              >
                <BtnSpinner on={updateMutation.isPending} />
                {t("detail.saveFilter")}
              </button>
            </div>
          </div>
        )}
      </section>

      <Modal
        open={renameTo !== null}
        onClose={closeRename}
        onConfirm={submitRename}
        title={t("detail.renameTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <div className="ms-field">
            <label htmlFor="seg-rename">{t("builder.nameLabel")}</label>
            <input
              id="seg-rename"
              className={`ms-input${renameMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              disabled={renameMutation.isPending}
              value={renameTo ?? ""}
              onChange={(event) => setRenameTo(event.target.value)}
            />
          </div>
          {renameMutation.isError ? (
            <p className="ms-field-error">{t("detail.renameError")}</p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeRename}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={renameMutation.isPending || (renameTo ?? "").trim() === ""}
            >
              <BtnSpinner on={renameMutation.isPending} />
              {t("detail.renameConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal
        open={confirmingDelete}
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
            {t("deleteBody", { name: data.name })}
          </p>
          {deleteMutation.isError ? (
            <p className="ms-field-error">
              {deleteMutation.error.data?.code === "CONFLICT" ? t("deleteInUse") : t("deleteError")}
            </p>
          ) : null}
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
              {t("deleteConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
