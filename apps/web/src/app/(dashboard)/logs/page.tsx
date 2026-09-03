"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useMemo } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { type BadgeStatus, StatusDot } from "@/components/status-badge";
import { Table } from "@/components/table";
import { codeRichTags } from "@/lib/code-rich-tags";
import { type RangeKey, rangeSince } from "@/lib/list-range";
import { statusCodeColor } from "@/lib/status-code-color";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { ListFooter, SearchBox, StateCard } from "../emails/list-parts";

const STATUS_CLASSES = ["2xx", "4xx", "5xx"] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];
const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];
const SOURCES = ["api_key", "mcp"] as const;
type Source = (typeof SOURCES)[number];
const RANGE_KEYS: RangeKey[] = ["all", "h24", "d7", "d15", "d30"];

// Filter dots borrow the email-status hues they read as: a 2xx is a delivery,
// a 4xx a complaint, a 5xx a failure; verbs go from the quiet read to the
// destructive delete.
const STATUS_CLASS_DOT: Record<StatusClass, BadgeStatus> = {
  "2xx": "delivered",
  "4xx": "complained",
  "5xx": "failed",
};
const METHOD_DOT: Record<Method, BadgeStatus> = {
  GET: "opened",
  POST: "delivered",
  PATCH: "complained",
  DELETE: "failed",
};

const COL = { method: "12%", source: "11%", status: "10%", when: "14%" } as const;

/**
 * Ghost stand-in mirroring the loaded table: mono chip, mono path bar,
 * source pill, status bar, right-aligned time bar. No spinners on lists.
 */
function LogsSkeleton({ headers }: { headers: [string, string, string, string, string] }) {
  const widths = ["58%", "42%", "66%", "50%", "38%", "62%", "46%", "54%"];
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: COL.method }}>{headers[0]}</th>
          <th>{headers[1]}</th>
          <th style={{ width: COL.source }}>{headers[2]}</th>
          <th style={{ width: COL.status }}>{headers[3]}</th>
          <th className="right" style={{ width: COL.when }}>
            {headers[4]}
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
              <SkeletonBadge width={58} />
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
  const [search, setSearch] = useUrlState("q");
  const [statusParam, setStatusClass] = useUrlState("status", "all");
  const [methodParam, setMethod] = useUrlState("method", "all");
  const [sourceParam, setSource] = useUrlState("source", "all");
  const [rangeParam, setRange] = useUrlState("range", "all");
  const statusClass: StatusClass | "all" = oneOf(STATUS_CLASSES, statusParam, "all");
  const method: Method | "all" = oneOf(METHODS, methodParam, "all");
  const source: Source | "all" = oneOf(SOURCES, sourceParam, "all");
  const range: RangeKey = oneOf(RANGE_KEYS, rangeParam, "all");
  const deferredSearch = useDeferredValue(search.trim());
  const since = useMemo(() => rangeSince(range), [range]);
  const hasFilters =
    deferredSearch !== "" ||
    statusClass !== "all" ||
    method !== "all" ||
    source !== "all" ||
    range !== "all";
  function clearFilters() {
    setSearch("");
    setStatusClass("all");
    setMethod("all");
    setSource("all");
    setRange("all");
  }

  const query = useInfiniteQuery(
    trpc.logs.list.infiniteQueryOptions(
      {
        limit: 40,
        ...(statusClass !== "all" ? { statusClass } : {}),
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(method !== "all" ? { method } : {}),
        ...(source !== "all" ? { source } : {}),
        ...(since ? { since } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const headers: [string, string, string, string, string] = [
    t("list.method"),
    t("list.path"),
    t("list.source"),
    t("list.status"),
    t("list.when"),
  ];

  return (
    <>
      <PageHeader title={t("list.title")} />

      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <SearchBox value={search} onChange={setSearch} placeholder={t("list.searchPlaceholder")} />
        <Select
          value={range}
          onChange={setRange}
          width={140}
          ariaLabel={t(`list.range.${range}`)}
          options={RANGE_KEYS.map((key) => ({ value: key, label: t(`list.range.${key}`) }))}
        />
        <Select
          value={method}
          onChange={setMethod}
          width={140}
          ariaLabel={t("list.method")}
          options={[
            { value: "all", label: t("list.allMethods"), adornment: <StatusDot /> },
            ...METHODS.map((m) => ({
              value: m,
              label: m,
              adornment: <StatusDot status={METHOD_DOT[m]} />,
            })),
          ]}
        />
        <Select
          value={source}
          onChange={setSource}
          width={136}
          ariaLabel={t("list.source")}
          options={[
            { value: "all", label: t("list.allSources") },
            ...SOURCES.map((s) => ({ value: s, label: t(`list.sources.${s}`) })),
          ]}
        />
        <Select
          value={statusClass}
          onChange={setStatusClass}
          width={140}
          ariaLabel={t("list.status")}
          options={[
            { value: "all", label: t("list.allStatuses"), adornment: <StatusDot /> },
            ...STATUS_CLASSES.map((s) => ({
              value: s,
              label: s,
              adornment: <StatusDot status={STATUS_CLASS_DOT[s]} />,
            })),
          ]}
        />
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
        hasFilters ? (
          <StateCard
            headline={t("list.noMatch")}
            actionLabel={t("list.clearFilter")}
            onAction={clearFilters}
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
                <th style={{ width: COL.source }}>{headers[2]}</th>
                <th style={{ width: COL.status }}>{headers[3]}</th>
                <th className="right" style={{ width: COL.when }}>
                  {headers[4]}
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
                  <td>
                    <span className="ms-badge ms-badge-neutral">
                      {t(`list.sources.${row.apiKeyId ? "api_key" : "mcp"}`)}
                    </span>
                  </td>
                  <td className="ms-mono">
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
    </>
  );
}
