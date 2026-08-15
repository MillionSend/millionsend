"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonChip } from "@/components/skeleton";
import { Table } from "@/components/table";
import { codeRichTags } from "@/lib/code-rich-tags";
import { statusCodeColor } from "@/lib/status-code-color";
import { useTRPC } from "@/lib/trpc";
import { StateCard } from "../emails/list-parts";

const STATUS_CLASSES = ["2xx", "4xx", "5xx"] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];

const COL = { method: "12%", status: "12%", when: "14%" } as const;

/**
 * Ghost stand-in mirroring the loaded table: mono chip, mono path bar,
 * status bar, right-aligned time bar. No spinners on lists.
 */
function LogsSkeleton({ headers }: { headers: [string, string, string, string] }) {
  const widths = ["58%", "42%", "66%", "50%", "38%", "62%", "46%", "54%"];
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: COL.method }}>{headers[0]}</th>
          <th>{headers[1]}</th>
          <th style={{ width: COL.status }}>{headers[2]}</th>
          <th className="right" style={{ width: COL.when }}>
            {headers[3]}
          </th>
        </tr>
      </thead>
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <SkeletonChip width={54} />
            </td>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={28} height={13} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function LogsPage() {
  const t = useTranslations("logs");
  const trpc = useTRPC();
  const router = useRouter();
  const [statusClass, setStatusClass] = useState<StatusClass | "all">("all");

  const query = useInfiniteQuery(
    trpc.logs.list.infiniteQueryOptions(
      { limit: 40, ...(statusClass !== "all" ? { statusClass } : {}) },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const headers: [string, string, string, string] = [
    t("list.method"),
    t("list.path"),
    t("list.status"),
    t("list.when"),
  ];

  return (
    <>
      <PageHeader title={t("list.title")} />

      <div className="ms-tabs" style={{ marginBottom: 18 }}>
        {(["all", ...STATUS_CLASSES] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={statusClass === key ? "active" : undefined}
            onClick={() => setStatusClass(key)}
          >
            {key === "all" ? t("list.all") : key}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <LogsSkeleton headers={headers} />
      ) : query.isError ? (
        <StateCard
          headline={t("list.loadError")}
          actionLabel={t("list.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        statusClass !== "all" ? (
          <StateCard
            headline={t("list.noMatch")}
            actionLabel={t("list.clearFilter")}
            onAction={() => setStatusClass("all")}
          />
        ) : (
          <EmptyState
            area="logs"
            headline={t("list.empty")}
            body={t.rich("list.emptyHint", codeRichTags)}
          />
        )
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th style={{ width: COL.method }}>{headers[0]}</th>
                <th>{headers[1]}</th>
                <th style={{ width: COL.status }}>{headers[2]}</th>
                <th className="right" style={{ width: COL.when }}>
                  {headers[3]}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={row.id}
                  className="hoverable"
                  onClick={() => router.push(`/logs/${row.id}`)}
                >
                  <td>
                    <span className="ms-chip">{row.method}</span>
                  </td>
                  <td
                    className="ms-mono"
                    style={{
                      fontSize: 13,
                      maxWidth: 420,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Link href={`/logs/${row.id}`} onClick={(event) => event.stopPropagation()}>
                      {row.path}
                    </Link>
                  </td>
                  <td className="ms-mono" style={{ fontSize: 13 }}>
                    <span style={{ color: statusCodeColor(row.statusCode) }}>{row.statusCode}</span>
                  </td>
                  <td className="right">
                    <RelativeTime date={row.createdAt} />
                  </td>
                </tr>
              ))}
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
    </>
  );
}
