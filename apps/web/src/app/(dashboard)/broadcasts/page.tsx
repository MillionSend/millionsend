"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { StateCard } from "../emails/list-parts";
import { type BroadcastStatus, StatusPill } from "./parts";

function BroadcastsHead() {
  const t = useTranslations("broadcasts");
  return (
    <thead>
      <tr>
        <th style={{ width: "30%" }}>{t("list.name")}</th>
        <th style={{ width: "13%" }}>{t("list.status")}</th>
        <th style={{ width: "20%" }}>{t("list.targeting")}</th>
        <th className="right" style={{ width: "13%" }}>
          {t("list.recipients")}
        </th>
        <th className="right">{t("list.created")}</th>
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded broadcasts table: name, pill, audience, digits, time, trigger. */
function BroadcastsSkeleton() {
  const widths = ["58%", "42%", "66%", "50%", "38%"];
  return (
    <Table>
      <BroadcastsHead />
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <SkeletonBadge width={74} />
            </td>
            <td>
              <Skeleton width={widths[widths.length - 1 - row] ?? "50%"} />
            </td>
            <td className="right">
              <Skeleton width={36} />
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

function NewBroadcastButton() {
  const t = useTranslations("broadcasts");
  return (
    <Link className="ms-btn ms-btn-primary" href="/broadcasts/new">
      <PlusGlyph size={14} />
      {t("list.new")}
    </Link>
  );
}

export default function BroadcastsPage() {
  const t = useTranslations("broadcasts");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ id: string; name: string } | null>(null);

  const query = useInfiniteQuery(
    trpc.broadcasts.list.infiniteQueryOptions(
      { limit: 40 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  const invalidate = () => queryClient.invalidateQueries(trpc.broadcasts.pathFilter());
  const deleteMutation = useMutation(
    trpc.broadcasts.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        invalidate();
      },
    }),
  );
  const cancelMutation = useMutation(
    trpc.broadcasts.cancel.mutationOptions({
      onSuccess: () => {
        setCancelTarget(null);
        invalidate();
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose.
  const closeDelete = useCallback(() => setDeleteTarget(null), []);
  const closeCancel = useCallback(() => setCancelTarget(null), []);

  const confirmDelete = () => {
    if (deleteTarget && !deleteMutation.isPending) {
      deleteMutation.mutate({ id: deleteTarget.id });
    }
  };
  const confirmCancel = () => {
    if (cancelTarget && !cancelMutation.isPending) {
      cancelMutation.mutate({ id: cancelTarget.id });
    }
  };

  return (
    <>
      <PageHeader
        title={t("list.title")}
        actions={
          <>
            <NewBroadcastButton />
            <ResourceApiButton resource="broadcasts" />
          </>
        }
      />

      {query.isPending ? (
        <BroadcastsSkeleton />
      ) : query.isError ? (
        <StateCard
          headline={t("list.loadError")}
          actionLabel={t("list.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          area="broadcasts"
          headline={t("list.empty")}
          body={t("list.emptyHint")}
          cta={<NewBroadcastButton />}
        />
      ) : (
        <>
          <Table>
            <BroadcastsHead />
            <tbody>
              {items.map((row) => {
                const status = row.status as BroadcastStatus;
                const label = row.name ?? row.subject;
                const href =
                  status === "draft" ? `/broadcasts/${row.id}/edit` : `/broadcasts/${row.id}`;
                return (
                  <tr key={row.id} className="hoverable" onClick={() => router.push(href)}>
                    <td>
                      <Link
                        href={href}
                        style={{ color: "var(--ms-bone)" }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {label}
                      </Link>
                    </td>
                    <td>
                      <StatusPill status={status} />
                    </td>
                    <td>{row.segmentName ?? t("composer.segmentNone")}</td>
                    <td className="right ms-digits">
                      {row.recipients > 0 ? (
                        nf.format(row.recipients)
                      ) : (
                        <span style={{ color: "var(--ms-faint)" }}>—</span>
                      )}
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
                        items={
                          status === "draft"
                            ? [
                                {
                                  label: t("list.edit"),
                                  onSelect: () => router.push(`/broadcasts/${row.id}/edit`),
                                },
                                null,
                                {
                                  label: t("list.delete"),
                                  danger: true,
                                  onSelect: () => setDeleteTarget({ id: row.id, name: label }),
                                },
                              ]
                            : status === "scheduled"
                              ? [
                                  {
                                    label: t("list.view"),
                                    onSelect: () => router.push(`/broadcasts/${row.id}`),
                                  },
                                  null,
                                  {
                                    label: t("list.cancel"),
                                    danger: true,
                                    onSelect: () => setCancelTarget({ id: row.id, name: label }),
                                  },
                                ]
                              : [
                                  {
                                    label: t("list.view"),
                                    onSelect: () => router.push(`/broadcasts/${row.id}`),
                                  },
                                ]
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {query.hasNextPage ? (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {t("list.loadMore")}
              </button>
            </div>
          ) : null}
        </>
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        title={t("list.deleteTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmDelete();
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

      <Modal
        open={cancelTarget !== null}
        onClose={closeCancel}
        onConfirm={confirmCancel}
        title={t("detail.cancelTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmCancel();
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("detail.cancelBody", { name: cancelTarget?.name ?? "—" })}
          </p>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCancel}>
              {t("detail.keep")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={cancelMutation.isPending}
            >
              <BtnSpinner on={cancelMutation.isPending} />
              {t("detail.cancelConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
