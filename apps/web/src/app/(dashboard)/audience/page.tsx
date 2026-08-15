"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "./audience-tabs";

type DeleteTarget = { id: string; name: string; contacts: number };

function AudiencesHead() {
  const t = useTranslations("audience");
  return (
    <thead>
      <tr>
        <th style={{ width: "40%" }}>{t("list.name")}</th>
        <th className="right" style={{ width: "15%" }}>
          {t("list.contacts")}
        </th>
        <th className="right" style={{ width: "18%" }}>
          {t("list.unsubscribed")}
        </th>
        <th className="right">{t("list.created")}</th>
        {/* Overflow-action column — no header label. */}
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded audiences table: name text, two digit columns, time, action trigger. */
function AudiencesSkeleton() {
  return (
    <Table>
      <AudiencesHead />
      <tbody>
        {["46%", "62%", "38%"].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td className="right">
              <Skeleton width={28} height={13} />
            </td>
            <td className="right">
              <Skeleton width={28} height={13} />
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

export default function AudiencePage() {
  const t = useTranslations("audience");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const query = useQuery(trpc.audience.audiences.list.queryOptions());

  const invalidate = () => queryClient.invalidateQueries(trpc.audience.audiences.pathFilter());
  const createMutation = useMutation(
    trpc.audience.audiences.create.mutationOptions({
      onSuccess: ({ id }) => {
        setCreateOpen(false);
        setNewName("");
        invalidate();
        router.push(`/audience/${id}`);
      },
    }),
  );
  const deleteMutation = useMutation(
    trpc.audience.audiences.delete.mutationOptions({
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
        title={t("list.title")}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            <PlusGlyph size={14} />
            {t("list.create")}
          </button>
        }
      />
      <AudienceTabs />

      {query.isPending ? (
        <AudiencesSkeleton />
      ) : query.isError ? (
        <div
          style={{
            border: "1px solid var(--ms-line)",
            borderRadius: 16,
            padding: 22,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("list.loadError")}</div>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            style={{ marginTop: 12 }}
            onClick={() => query.refetch()}
          >
            {t("list.retry")}
          </button>
        </div>
      ) : query.data.length === 0 ? (
        <EmptyState
          area="audience"
          headline={t("list.empty")}
          body={t("list.emptyHint")}
          cta={
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph size={14} />
              {t("list.create")}
            </button>
          }
        />
      ) : (
        <Table>
          <AudiencesHead />
          <tbody>
            {query.data.map((row) => (
              <tr
                key={row.id}
                className="hoverable"
                onClick={() => router.push(`/audience/${row.id}`)}
              >
                <td>
                  <Link href={`/audience/${row.id}`} onClick={(event) => event.stopPropagation()}>
                    {row.name}
                  </Link>
                </td>
                <td className="right ms-mono" style={{ fontSize: 13 }}>
                  {nf.format(row.contacts)}
                </td>
                <td className="right ms-mono" style={{ fontSize: 13, color: "var(--ms-muted)" }}>
                  {nf.format(row.unsubscribed)}
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
                    ariaLabel={t("list.menu")}
                    items={[
                      {
                        label: t("list.delete"),
                        danger: true,
                        onSelect: () =>
                          setDeleteTarget({ id: row.id, name: row.name, contacts: row.contacts }),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={createOpen} onClose={closeCreate} title={t("list.createTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (createMutation.isPending || newName.trim().length === 0) return;
            createMutation.mutate({ name: newName.trim() });
          }}
        >
          <div className="ms-field">
            <label htmlFor="audience-name">{t("list.nameLabel")}</label>
            <input
              id="audience-name"
              className={`ms-input${createMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("list.namePlaceholder")}
              disabled={createMutation.isPending}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          {createMutation.isError ? (
            <p
              style={{
                margin: "8px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("list.createError")}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={createMutation.isPending || newName.trim().length === 0}
            >
              <BtnSpinner on={createMutation.isPending} />
              {t("list.createConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal open={deleteTarget !== null} onClose={closeDelete} title={t("list.deleteTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (deleteTarget && !deleteMutation.isPending) {
              deleteMutation.mutate({ id: deleteTarget.id });
            }
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("list.deleteBody", {
              name: deleteTarget?.name ?? "—",
              count: deleteTarget?.contacts ?? 0,
            })}
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
              {t("list.deleteConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
