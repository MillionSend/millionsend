"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "../audience-tabs";

type DeleteTarget = { id: string; name: string };

function TopicsHead() {
  const t = useTranslations("audience.topics");
  return (
    <thead>
      <tr>
        <th style={{ width: "52%" }}>{t("name")}</th>
        <th style={{ width: "18%" }}>{t("default")}</th>
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
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const query = useQuery(trpc.topics.list.queryOptions());

  const invalidate = () => queryClient.invalidateQueries(trpc.topics.pathFilter());
  const createMutation = useMutation(
    trpc.topics.create.mutationOptions({
      onSuccess: () => {
        setCreateOpen(false);
        setName("");
        setDescription("");
        setDefaultSub("opt_in");
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
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
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
      <AudienceTabs />

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
            {query.data.map((row) => (
              <tr key={row.id}>
                <td>
                  <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>{row.name}</div>
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
            if (createMutation.isPending || name.trim().length === 0) return;
            createMutation.mutate({
              name: name.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              defaultSubscribed: defaultSub === "opt_in",
            });
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
            <label htmlFor="topic-default">{t("defaultLabel")}</label>
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
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={closeCreate}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={createMutation.isPending || name.trim().length === 0}
            >
              <BtnSpinner on={createMutation.isPending} />
              {t("createConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </div>
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
          <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("deleteBody", { name: deleteTarget?.name ?? "—" })}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={closeDelete}>
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
          </div>
        </form>
      </Modal>
    </>
  );
}
