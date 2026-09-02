"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { ResourceApiButton } from "@/components/api-sheet";
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
import { Tooltip } from "@/components/tooltip";
import { toPreviewTopics, UnsubscribePreview } from "@/components/unsubscribe-preview";
import { useTRPC } from "@/lib/trpc";
import { useUrlState } from "@/lib/url-state";
import { useCopied } from "@/lib/use-copied";
import { ListFooter, PAGE_SIZES, SearchBox, StateCard } from "../../emails/list-parts";
import { AudienceTabs } from "../audience-tabs";
import { TopicDeleteModal, TopicEditModal, type TopicEditTarget } from "./topic-modals";

type Visibility = "private" | "public";

function TopicsHead() {
  const t = useTranslations("audience.topics");
  return (
    <thead>
      <tr>
        <th style={{ width: "42%" }}>{t("name")}</th>
        <th style={{ width: "14%" }}>{t("default")}</th>
        <th style={{ width: "14%" }}>{t("visibility")}</th>
        <th className="right">{t("created")}</th>
        {/* Overflow-action column — no header label. */}
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded topics table: name text, a badge, time, action trigger. */
function TopicsSkeleton() {
  return (
    <Table>
      <TopicsHead />
      <tbody>
        {["44%", "60%", "36%"].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={58} height={18} radius={999} />
            </td>
            <td>
              <Skeleton width={44} height={13} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
            <td className="right" style={{ width: 40 }}>
              <Skeleton width={28} height={28} radius={8} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function TopicsPage() {
  const t = useTranslations("audience.topics");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Stored as the wire label to match the Select; mapped to a boolean on submit.
  const [defaultSub, setDefaultSub] = useState<"opt_in" | "opt_out">("opt_in");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [editTarget, setEditTarget] = useState<TopicEditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useUrlState("q");
  const [size, setSize] = useState<number>(PAGE_SIZES[1]);
  const [pages, setPages] = useState(1);
  const { copied, copy } = useCopied();

  const query = useQuery(trpc.topics.list.queryOptions());
  const unsubSettings = useQuery(trpc.settings.unsubscribe.get.queryOptions());
  const team = useQuery(trpc.settings.team.get.queryOptions());

  const createMutation = useMutation(
    trpc.topics.create.mutationOptions({
      onSuccess: () => {
        setCreateOpen(false);
        setName("");
        setDescription("");
        setDefaultSub("opt_in");
        setVisibility("private");
        queryClient.invalidateQueries(trpc.topics.pathFilter());
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose.
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeEdit = useCallback(() => setEditTarget(null), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const submitCreate = () => {
    if (createMutation.isPending || name.trim().length === 0) return;
    createMutation.mutate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      defaultSubscribed: defaultSub === "opt_in",
      visibility,
    });
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
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph size={14} />
              {t("create")}
            </button>
            <ResourceApiButton resource="topics" />
          </>
        }
      />
      <AudienceTabs />

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div
            className="ms-filter-row"
            style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
          >
            <SearchBox value={search} onChange={setSearch} placeholder={t("searchPlaceholder")} />
          </div>

          {query.isPending ? (
            <TopicsSkeleton />
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
                <TopicsHead />
                <tbody>
                  {shownRows.map((row) => {
                    const detailHref = `/audience/topics/${row.id}`;
                    return (
                      <tr
                        key={row.id}
                        className="hoverable"
                        onClick={() => router.push(detailHref)}
                      >
                        <td>
                          <div style={{ fontSize: 14 }}>
                            <Link
                              href={detailHref}
                              style={{ color: "var(--ms-bone)" }}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {row.name}
                            </Link>
                            {copied === row.id ? (
                              <span
                                style={{ marginLeft: 8, color: "var(--ms-muted)", fontSize: 12.5 }}
                              >
                                ✓ {common("copied")}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <span
                            className={`ms-badge ${row.defaultSubscribed ? "ms-badge-success" : "ms-badge-neutral"}`}
                          >
                            {row.defaultSubscribed ? t("optIn") : t("optOut")}
                          </span>
                        </td>
                        <td style={{ color: "var(--ms-muted)" }}>
                          {row.visibility === "public"
                            ? t("visibilityPublic")
                            : t("visibilityPrivate")}
                        </td>
                        <td className="right" style={{ color: "var(--ms-muted)" }}>
                          <RelativeTime date={row.createdAt} />
                        </td>
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only guard so a menu click does not also trigger the row navigation; keyboard users reach the menu button directly */}
                        <td
                          className="right"
                          style={{ width: 40 }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <PopoverMenu
                            ariaLabel={t("menu")}
                            items={[
                              {
                                label: t("editTitle"),
                                onSelect: () =>
                                  setEditTarget({
                                    id: row.id,
                                    name: row.name,
                                    description: row.description ?? "",
                                    visibility: row.visibility,
                                    defaultSubscribed: row.defaultSubscribed,
                                  }),
                              },
                              { label: t("copyId"), onSelect: () => copy(row.id) },
                              null,
                              {
                                label: t("delete"),
                                danger: true,
                                onSelect: () => setDeleteTarget({ id: row.id, name: row.name }),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <ListFooter
                left={t("pageOf", {
                  pages: Math.max(1, Math.ceil(shownRows.length / size)),
                  total: filteredRows.length,
                })}
                size={size}
                onSize={changeSize}
                sizeLabel={(value) => t("pageSize", { count: value })}
                singlePage={!hasMore && pages === 1}
                loadMore={
                  hasMore
                    ? { label: t("loadMore"), onClick: () => setPages((prev) => prev + 1) }
                    : undefined
                }
              />
            </>
          )}
        </div>

        <aside style={{ flex: "1 1 340px", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <p className="ms-microlabel" style={{ margin: 0 }}>
              {t("previewTitle")}
            </p>
            <Link href="/settings/unsubscribe" className="ms-btn ms-btn-ghost">
              {t("customize")}
            </Link>
          </div>
          {unsubSettings.data ? (
            <UnsubscribePreview
              topics={toPreviewTopics(query.data ?? [])}
              customization={{
                brandName: unsubSettings.data.brandName ?? unsubSettings.data.teamName,
                message: unsubSettings.data.message,
                successMessage: unsubSettings.data.successMessage,
                // hideBranding is the "show my logo" opt-in; team.get already
                // nulls logoUrl when object storage is off.
                logoUrl: unsubSettings.data.hideBranding ? (team.data?.logoUrl ?? null) : null,
                backgroundColor: unsubSettings.data.backgroundColor,
                textColor: unsubSettings.data.textColor,
                accentColor: unsubSettings.data.accentColor,
              }}
            />
          ) : (
            <Skeleton width="100%" height={420} radius="var(--ms-r-card)" />
          )}
        </aside>
      </div>

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
            <label htmlFor="topic-name">{t("nameLabel")}</label>
            <input
              id="topic-name"
              className={`ms-input${createMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("namePlaceholder")}
              disabled={createMutation.isPending}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="topic-description">{t("descriptionLabel")}</label>
            <input
              id="topic-description"
              className="ms-input"
              style={{ width: "100%" }}
              placeholder={t("descriptionPlaceholder")}
              disabled={createMutation.isPending}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <div className="ms-label-row">
              <label htmlFor="topic-default">{t("defaultLabel")}</label>
              <Tooltip text={t("defaultHint")} />
            </div>
            <Select
              id="topic-default"
              value={defaultSub}
              onChange={(value) => setDefaultSub(value === "opt_out" ? "opt_out" : "opt_in")}
              ariaLabel={t("defaultLabel")}
              width="100%"
              disabled={createMutation.isPending}
              options={[
                { value: "opt_in", label: t("defaultOptIn") },
                { value: "opt_out", label: t("defaultOptOut") },
              ]}
            />
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--ms-faint)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("defaultImmutable")}
            </p>
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <div className="ms-label-row">
              <label htmlFor="topic-visibility">{t("visibilityLabel")}</label>
              <Tooltip text={t("visibilityTooltip")} />
            </div>
            <Select
              id="topic-visibility"
              value={visibility}
              onChange={(value) => setVisibility(value === "public" ? "public" : "private")}
              ariaLabel={t("visibilityLabel")}
              width="100%"
              disabled={createMutation.isPending}
              options={[
                { value: "private", label: t("visibilityPrivate") },
                { value: "public", label: t("visibilityPublic") },
              ]}
            />
          </div>
          {createMutation.isError ? <p className="ms-field-error">{t("createError")}</p> : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={createMutation.isPending || name.trim().length === 0}
            >
              <BtnSpinner on={createMutation.isPending} />
              {t("createConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <TopicEditModal target={editTarget} onClose={closeEdit} />
      <TopicDeleteModal target={deleteTarget} onClose={closeDelete} />
    </>
  );
}
