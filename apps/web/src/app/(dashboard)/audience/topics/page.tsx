"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useTRPC } from "@/lib/trpc";
import { useUrlState } from "@/lib/url-state";
import { SearchBox } from "../../emails/list-parts";
import { AudienceTabs } from "../audience-tabs";

type DeleteTarget = { id: string; name: string };
type Visibility = "private" | "public";
type EditTarget = {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  defaultSubscribed: boolean;
};

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
              <Skeleton width={22} height={30} radius="var(--ms-r-input)" />
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
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Stored as the wire label to match the Select; mapped to a boolean on submit.
  const [defaultSub, setDefaultSub] = useState<"opt_in" | "opt_out">("opt_in");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [search, setSearch] = useUrlState("q");

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1600);
  };

  const query = useQuery(trpc.topics.list.queryOptions());

  const invalidate = () => queryClient.invalidateQueries(trpc.topics.pathFilter());
  const createMutation = useMutation(
    trpc.topics.create.mutationOptions({
      onSuccess: () => {
        setCreateOpen(false);
        setName("");
        setDescription("");
        setDefaultSub("opt_in");
        setVisibility("private");
        invalidate();
      },
    }),
  );
  const updateMutation = useMutation(
    trpc.topics.update.mutationOptions({
      onSuccess: () => {
        setEditTarget(null);
        invalidate();
      },
    }),
  );
  const deleteMutation = useMutation(
    trpc.topics.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        invalidate();
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

  const submitEdit = () => {
    if (!editTarget || updateMutation.isPending || editTarget.name.trim().length === 0) return;
    updateMutation.mutate({
      id: editTarget.id,
      name: editTarget.name.trim(),
      ...(editTarget.description.trim() ? { description: editTarget.description.trim() } : {}),
      visibility: editTarget.visibility,
    });
  };

  const submitDelete = () => {
    if (deleteTarget && !deleteMutation.isPending) {
      deleteMutation.mutate({ id: deleteTarget.id });
    }
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
      ) : (
        <Table>
          <TopicsHead />
          <tbody>
            {query.data
              .filter((row) => row.name.toLowerCase().includes(search.trim().toLowerCase()))
              .map((row) => (
                <tr key={row.id}>
                  <td>
                    <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>
                      {row.name}
                      {copiedId === row.id ? (
                        <span style={{ marginLeft: 8, color: "var(--ms-muted)", fontSize: 12.5 }}>
                          ✓ {common("copied")}
                        </span>
                      ) : null}
                    </div>
                    {row.description ? (
                      <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 2 }}>
                        {row.description}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`ms-badge ${row.defaultSubscribed ? "ms-badge-success" : "ms-badge-neutral"}`}
                    >
                      {row.defaultSubscribed ? t("optIn") : t("optOut")}
                    </span>
                  </td>
                  <td style={{ color: "var(--ms-muted)" }}>
                    {row.visibility === "public" ? t("visibilityPublic") : t("visibilityPrivate")}
                  </td>
                  <td className="right" style={{ color: "var(--ms-muted)" }}>
                    <RelativeTime date={row.createdAt} />
                  </td>
                  <td className="right" style={{ width: 40 }}>
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
                        { label: t("copyId"), onSelect: () => copyId(row.id) },
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
          {createMutation.isError ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("createError")}
            </p>
          ) : null}
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

      <Modal
        open={editTarget !== null}
        onClose={closeEdit}
        onConfirm={submitEdit}
        title={t("editTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitEdit();
          }}
        >
          <div className="ms-field">
            <label htmlFor="topic-edit-name">{t("nameLabel")}</label>
            <input
              id="topic-edit-name"
              className={`ms-input${updateMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("namePlaceholder")}
              disabled={updateMutation.isPending}
              value={editTarget?.name ?? ""}
              onChange={(event) =>
                setEditTarget((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="topic-edit-description">{t("descriptionLabel")}</label>
            <input
              id="topic-edit-description"
              className="ms-input"
              style={{ width: "100%" }}
              placeholder={t("descriptionPlaceholder")}
              disabled={updateMutation.isPending}
              value={editTarget?.description ?? ""}
              onChange={(event) =>
                setEditTarget((prev) =>
                  prev ? { ...prev, description: event.target.value } : prev,
                )
              }
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <div className="ms-label-row">
              <label htmlFor="topic-edit-visibility">{t("visibilityLabel")}</label>
              <Tooltip text={t("visibilityTooltip")} />
            </div>
            <Select
              id="topic-edit-visibility"
              value={editTarget?.visibility ?? "private"}
              onChange={(value) =>
                setEditTarget((prev) =>
                  prev ? { ...prev, visibility: value === "public" ? "public" : "private" } : prev,
                )
              }
              ariaLabel={t("visibilityLabel")}
              width="100%"
              disabled={updateMutation.isPending}
              options={[
                { value: "private", label: t("visibilityPrivate") },
                { value: "public", label: t("visibilityPublic") },
              ]}
            />
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="topic-edit-default">{t("defaultLabel")}</label>
            <Select
              id="topic-edit-default"
              value={editTarget?.defaultSubscribed === false ? "opt_out" : "opt_in"}
              onChange={() => {}}
              ariaLabel={t("defaultLabel")}
              width="100%"
              disabled
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
          {updateMutation.isError ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("editError")}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeEdit}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={updateMutation.isPending || (editTarget?.name.trim().length ?? 0) === 0}
            >
              <BtnSpinner on={updateMutation.isPending} />
              {t("editConfirm")} <ConfirmKeycap />
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
