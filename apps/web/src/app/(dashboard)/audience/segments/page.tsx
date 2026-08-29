"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { ResourceApiButton } from "@/components/api-sheet";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { type BuilderRow, buildSegmentFilter, type MatchMode } from "@/lib/segment-builder";
import { useTRPC } from "@/lib/trpc";
import { useUrlState } from "@/lib/url-state";
import { useCopied } from "@/lib/use-copied";
import { ListFooter, PAGE_SIZES, SearchBox, StateCard } from "../../emails/list-parts";
import { AudienceTabs } from "../audience-tabs";
import { FilterConditions, FilterCountPreview } from "./filter-builder";

type DeleteTarget = { id: string; name: string };

function SegmentsHead() {
  const t = useTranslations("audience.segments");
  return (
    <thead>
      <tr>
        <th style={{ width: "42%" }}>{t("name")}</th>
        <th className="right">{t("count")}</th>
        <th className="right">{t("unsubscribed")}</th>
        <th className="right">{t("created")}</th>
        {/* Overflow-action column — no header label. */}
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded segments table: name link, two counts, time, action. */
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

export default function SegmentsPage() {
  const t = useTranslations("audience.segments");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [match, setMatch] = useState<MatchMode>("all");
  const [rows, setRows] = useState<BuilderRow[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const [search, setSearch] = useUrlState("q");
  const [size, setSize] = useState<number>(PAGE_SIZES[1]);
  const [pages, setPages] = useState(1);

  const { copied: copiedId, copy: copyId } = useCopied();

  const query = useQuery(trpc.segments.list.queryOptions());

  const filter = useMemo(() => buildSegmentFilter(match, rows), [match, rows]);

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

  const openDelete = (target: DeleteTarget) => {
    deleteMutation.reset();
    setDeleteTarget(target);
  };

  const canSave = name.trim() !== "" && !createMutation.isPending;

  const submitCreate = () => {
    if (!canSave) return;
    createMutation.mutate({ name: name.trim(), filter });
  };

  const submitDelete = () => {
    if (deleteTarget && !deleteMutation.isPending) {
      deleteMutation.mutate({ id: deleteTarget.id });
    }
  };

  const q = search.trim().toLowerCase();
  const filteredRows = (query.data ?? []).filter((row) => row.name.toLowerCase().includes(q));
  const shownRows = filteredRows.slice(0, pages * size);
  const hasMore = filteredRows.length > shownRows.length;

  const changeSize = (next: number) => {
    setSize(next);
    setPages(1);
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <>
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
            <ResourceApiButton resource="segments" />
          </>
        }
      />
      <AudienceTabs />

      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <SearchBox value={search} onChange={setSearch} placeholder={t("searchPlaceholder")} />
      </div>

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
      ) : filteredRows.length === 0 ? (
        <StateCard
          headline={t("noMatch")}
          actionLabel={t("clearFilters")}
          onAction={() => setSearch("")}
        />
      ) : (
        <>
          <Table>
            <SegmentsHead />
            <tbody>
              {shownRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div style={{ fontSize: 14 }}>
                      <Link
                        href={`/audience/segments/${row.id}`}
                        style={{ color: "var(--ms-bone)" }}
                      >
                        {row.name}
                      </Link>
                      {/* Null filter = manual segment (membership added via the
                          API); the builder only edits filter segments. */}
                      {row.filter === null ? (
                        <span
                          style={{
                            marginLeft: 8,
                            color: "var(--ms-faint)",
                            fontSize: "var(--ms-fs-label)",
                          }}
                        >
                          {t("manual")}
                        </span>
                      ) : null}
                      {copiedId === row.id ? (
                        <span style={{ marginLeft: 8, color: "var(--ms-muted)", fontSize: 12.5 }}>
                          ✓ {common("copied")}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="right ms-mono" style={{ fontSize: 13 }}>
                    {nf.format(row.count)}
                  </td>
                  <td className="right ms-mono" style={{ fontSize: 13, color: "var(--ms-muted)" }}>
                    {nf.format(row.unsubscribedCount)}
                  </td>
                  <td className="right" style={{ color: "var(--ms-muted)" }}>
                    <RelativeTime date={row.createdAt} />
                  </td>
                  <td className="right" style={{ width: 40 }}>
                    <PopoverMenu
                      ariaLabel={t("menu")}
                      items={[
                        {
                          label: t("edit"),
                          onSelect: () => router.push(`/audience/segments/${row.id}`),
                        },
                        { label: t("copyId"), onSelect: () => copyId(row.id) },
                        null,
                        {
                          label: t("delete"),
                          danger: true,
                          onSelect: () => openDelete({ id: row.id, name: row.name }),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {hasMore ? (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => setPages((prev) => prev + 1)}
              >
                {t("loadMore")}
              </button>
            </div>
          ) : null}
          <ListFooter
            left={t("pageOf", {
              pages: Math.max(1, Math.ceil(shownRows.length / size)),
              total: nf.format(filteredRows.length),
            })}
            size={size}
            onSize={changeSize}
            sizeLabel={(value) => t("pageSize", { count: value })}
            singlePage={!hasMore && pages === 1}
          />
        </>
      )}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        onConfirm={submitCreate}
        title={t("createTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitCreate();
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

          <FilterConditions match={match} onMatch={setMatch} rows={rows} onRows={setRows} />

          <FilterCountPreview filter={filter} enabled={createOpen} />

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
              {t("builder.save")} <ConfirmKeycap />
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
            {t("deleteBody", { name: deleteTarget?.name ?? "—" })}
          </p>
          {deleteMutation.isError ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
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
