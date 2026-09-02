"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
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
import { useTRPC } from "@/lib/trpc";
import { ListFooter, StateCard } from "../emails/list-parts";

function TemplatesHead() {
  const t = useTranslations("templates");
  return (
    <thead>
      <tr>
        <th style={{ width: "64%" }}>{t("list.name")}</th>
        <th className="right">{t("list.updated")}</th>
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded templates table: name, time, trigger. */
function TemplatesSkeleton() {
  const widths = ["46%", "62%", "38%", "54%", "42%"];
  return (
    <Table>
      <TemplatesHead />
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <Skeleton width={width} height={13} />
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

function NewTemplateButton() {
  const t = useTranslations("templates");
  return (
    <Link className="ms-btn ms-btn-primary" href="/templates/new">
      <PlusGlyph size={14} />
      {t("list.new")}
    </Link>
  );
}

export default function TemplatesPage() {
  const t = useTranslations("templates");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const query = useInfiniteQuery(
    trpc.templates.list.infiniteQueryOptions(
      { limit: 40 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const invalidate = () => queryClient.invalidateQueries(trpc.templates.pathFilter());
  const deleteMutation = useMutation(
    trpc.templates.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        invalidate();
      },
    }),
  );
  const duplicateMutation = useMutation(
    trpc.templates.duplicate.mutationOptions({ onSuccess: invalidate }),
  );

  // Stable identity: Modal's focus effect depends on onClose.
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  // Guard mirrors the delete button's disabled state — the same check gates
  // both the form submit and Modal's Cmd+Enter path.
  const submitDelete = () => {
    if (!deleteTarget || deleteMutation.isPending) return;
    deleteMutation.mutate({ id: deleteTarget.id });
  };

  return (
    <>
      <PageHeader title={t("list.title")} actions={<NewTemplateButton />} />

      {query.isPending ? (
        <TemplatesSkeleton />
      ) : query.isError ? (
        <StateCard
          headline={t("list.loadError")}
          actionLabel={t("list.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          area="templates"
          headline={t("list.empty")}
          body={t("list.emptyHint")}
          cta={<NewTemplateButton />}
        />
      ) : (
        <>
          <Table>
            <TemplatesHead />
            <tbody>
              {items.map((row) => {
                const href = `/templates/${row.id}/edit`;
                return (
                  <tr key={row.id} className="hoverable" onClick={() => router.push(href)}>
                    <td>
                      <Link
                        href={href}
                        style={{ color: "var(--ms-bone)" }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="right" style={{ color: "var(--ms-muted)" }}>
                      <RelativeTime date={row.updatedAt} />
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
                          { label: t("list.edit"), onSelect: () => router.push(href) },
                          {
                            label: t("list.duplicate"),
                            onSelect: () => duplicateMutation.mutate({ id: row.id }),
                          },
                          null,
                          {
                            label: t("list.delete"),
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
          {query.hasNextPage ? (
            <ListFooter
              loadMore={{
                label: t("list.loadMore"),
                onClick: () => query.fetchNextPage(),
                loading: query.isFetchingNextPage,
              }}
            />
          ) : null}
        </>
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        onConfirm={submitDelete}
        title={t("list.deleteTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitDelete();
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("list.deleteBody", { name: deleteTarget?.name ?? "—" })}
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
              {t("list.deleteConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
