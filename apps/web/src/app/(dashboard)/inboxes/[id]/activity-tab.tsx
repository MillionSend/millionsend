"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ListFooter } from "@/components/list-footer";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { Truncated } from "@/components/truncated";
import { useTRPC } from "@/lib/trpc";
import { StateCard } from "../../emails/list-parts";
import { approvalReasonWords } from "../parts";

/** Who did what to the inbox: people, keys, connected apps and the system, newest first. */
export function ActivityTab({ inboxId }: { inboxId: string }) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const query = useInfiniteQuery(
    trpc.inboxes.activity.list.infiniteQueryOptions(
      { inboxId, limit: 50 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  if (query.isPending) return <Skeleton width="50%" height={14} />;
  if (query.isError) {
    return (
      <StateCard
        tone="error"
        headline={t("activity.loadError")}
        actionLabel={t("retry")}
        onAction={() => query.refetch()}
      />
    );
  }
  const rows = query.data.pages.flatMap((page) => page.items);
  if (rows.length === 0) {
    return <StateCard headline={t("activity.empty")} />;
  }
  return (
    <>
      <Table>
        <thead>
          <tr>
            <th style={{ width: 120 }}>{t("activity.when")}</th>
            <th style={{ width: "26%" }}>{t("activity.who")}</th>
            <th>{t("activity.what")}</th>
            <th>{t("activity.why")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={{ whiteSpace: "nowrap" }}>
                <RelativeTime date={row.createdAt} />
              </td>
              <td className="ms-cell-fill">
                <Truncated text={row.actor.name ?? t(`activity.actor.${row.actor.kind}`)} />
              </td>
              <td className="ms-cell-fill">
                <Truncated
                  text={
                    t.has(`activity.actions.${row.action}`)
                      ? t(`activity.actions.${row.action}`)
                      : row.action
                  }
                />
              </td>
              <td className="ms-cell-fill" style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
                {row.decision ? (
                  <Truncated text={approvalReasonWords(t, row.decision.reasons)} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ListFooter
        singlePage={!query.hasNextPage}
        loadMore={
          query.hasNextPage
            ? {
                label: t("loadMore"),
                onClick: () => query.fetchNextPage(),
                loading: query.isFetchingNextPage,
              }
            : undefined
        }
      />
    </>
  );
}
