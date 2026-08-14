"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { Table } from "@/components/table";
import { formatHoursMinutes } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { FilterSelect, ListFooter, ListSkeleton, SearchBox, StateCard } from "./list-parts";

// Keep in enum order (packages/db schema.emailStatusEnum) — the router input
// rejects anything outside it at typecheck time.
const STATUSES = [
  "queued_quota",
  "queued",
  "sent",
  "delivery_delayed",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "suppressed",
  "failed",
] as const;

type EmailStatus = (typeof STATUSES)[number];

const RANGE_HOURS = { h24: 24, d7: 168, d15: 360, d30: 720 } as const;
type RangeKey = keyof typeof RANGE_HOURS | "all";
const RANGE_KEYS: RangeKey[] = ["h24", "d7", "d15", "d30", "all"];

/** ms until the daily quota resets (midnight UTC). */
function msToUtcMidnight(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
}

export default function EmailsPage() {
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<EmailStatus | "all">("all");
  const [range, setRange] = useState<RangeKey>("d15");
  const [apiKeyId, setApiKeyId] = useState("all");
  const [limit, setLimit] = useState(40);
  const deferredSearch = useDeferredValue(search.trim());
  const since = useMemo(
    () => (range === "all" ? undefined : new Date(Date.now() - RANGE_HOURS[range] * 3_600_000)),
    [range],
  );

  const query = useInfiniteQuery(
    trpc.emails.list.infiniteQueryOptions(
      {
        limit,
        ...(status !== "all" ? { status } : {}),
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(apiKeyId !== "all" ? { apiKeyId } : {}),
        ...(since ? { since } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const stats = useQuery(trpc.emails.stats.queryOptions());
  const usage = useQuery(trpc.settings.usage.recent.queryOptions({}));
  const apiKeys = useQuery(trpc.apiKeys.list.queryOptions());

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  const subtitle = stats.data
    ? [
        t("list.sentToday", { count: nf.format(stats.data.sentToday) }),
        t("list.deliveredAllTime", { count: nf.format(stats.data.deliveredAllTime) }),
        ...(stats.data.p50DeliveryMs != null
          ? [t("list.p50Delivery", { ms: nf.format(stats.data.p50DeliveryMs) })]
          : []),
      ].join(" · ")
    : undefined;

  const capReached =
    usage.data?.today.limit != null && usage.data.today.accepted >= usage.data.today.limit;

  const hasFilters =
    deferredSearch !== "" || status !== "all" || apiKeyId !== "all" || range !== "all";
  // A team that has never sent gets the onboarding empty state even under the
  // default 15-day window; anything else filtered to zero gets "clear filters".
  const neverSent =
    stats.data != null &&
    stats.data.sentToday === 0 &&
    stats.data.deliveredAllTime === 0 &&
    stats.data.queuedQuota === 0;

  function clearFilters() {
    setSearch("");
    setStatus("all");
    setApiKeyId("all");
    setRange("all");
  }

  const filterSummary = [
    ...(deferredSearch ? [`"${deferredSearch}"`] : []),
    ...(status !== "all" ? [t("list.statusFilter", { status: common(`status.${status}`) })] : []),
    ...(range !== "all" ? [t(`list.range.${range}`)] : []),
  ].join(" · ");

  return (
    <>
      <PageHeader
        title={t("list.title")}
        {...(subtitle ? { subtitle } : {})}
        actions={
          <>
            <Link className="ms-btn ms-btn-secondary" href="/emails/suppressions">
              {t("list.suppressionList")}
            </Link>
            <a className="ms-btn ms-btn-icon" href="#emails-api" aria-label={t("list.apiDocs")}>
              {"</>"}
            </a>
          </>
        }
      />

      {capReached && usage.data?.today.limit != null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            backgroundColor: "#050505",
            backgroundImage:
              "radial-gradient(130% 200% at 0% 50%, rgba(217,174,95,.14), rgba(217,174,95,0) 58%)",
            border: "1px solid var(--ms-warn-border)",
            borderRadius: 12,
            padding: "12px 16px",
            marginBottom: 20,
          }}
        >
          <span style={{ fontSize: 13.5, color: "var(--ms-warn)" }}>
            {t("list.capBanner.reached", { limit: nf.format(usage.data.today.limit) })}
          </span>
          {stats.data && stats.data.queuedQuota > 0 ? (
            <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
              {t("list.capBanner.queued", {
                count: nf.format(stats.data.queuedQuota),
                duration: formatHoursMinutes(msToUtcMidnight()),
              })}
            </span>
          ) : null}
          <Link
            href="/settings"
            style={{
              marginLeft: "auto",
              fontSize: 13.5,
              color: "var(--ms-bone)",
              textDecoration: "underline dotted var(--ms-muted)",
              textUnderlineOffset: 3,
            }}
          >
            {t("list.capBanner.upgrade")}
          </Link>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}>
        <SearchBox value={search} onChange={setSearch} placeholder={t("list.searchPlaceholder")} />
        <FilterSelect
          value={range}
          onChange={(value) => setRange(value as RangeKey)}
          width={130}
          ariaLabel={t(`list.range.${range}`)}
        >
          {RANGE_KEYS.map((key) => (
            <option key={key} value={key}>
              {t(`list.range.${key}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={status}
          onChange={(value) => setStatus(value as EmailStatus | "all")}
          width={126}
          ariaLabel={t("list.status")}
        >
          <option value="all">{t("list.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {common(`status.${s}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={apiKeyId}
          onChange={setApiKeyId}
          width={126}
          ariaLabel={t("list.allApiKeys")}
        >
          <option value="all">{t("list.allApiKeys")}</option>
          {(apiKeys.data ?? []).map((key) => (
            <option key={key.id} value={key.id}>
              {key.name}
            </option>
          ))}
        </FilterSelect>
      </div>

      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <StateCard
          headline={t("list.loadError")}
          actionLabel={t("list.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        hasFilters && !neverSent ? (
          <StateCard
            headline={t("list.noMatch")}
            {...(filterSummary ? { detail: filterSummary } : {})}
            actionLabel={t("list.clearFilters")}
            onAction={clearFilters}
          />
        ) : (
          <EmptyState headline={t("list.empty")} body={t("list.emptyHint")} />
        )
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th style={{ width: "34%" }}>{t("list.to")}</th>
                <th style={{ width: "15%" }}>{t("list.status")}</th>
                <th>{t("list.subject")}</th>
                <th className="right" style={{ width: "13%" }}>
                  {t("list.sent")}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={row.id}
                  className="hoverable"
                  onClick={() => router.push(`/emails/${row.id}`)}
                >
                  <td className="ms-mono" style={{ fontSize: 13 }}>
                    <Link href={`/emails/${row.id}`} onClick={(event) => event.stopPropagation()}>
                      {row.to[0] ?? row.subject}
                    </Link>
                    {row.to.length > 1 ? (
                      <span style={{ color: "var(--ms-muted)", marginLeft: 8 }}>
                        +{row.to.length - 1}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <StatusBadge status={row.latestStatus} />
                  </td>
                  <td>{row.subject}</td>
                  <td className="right">
                    <RelativeTime date={row.createdAt} />
                    <span aria-hidden="true" style={{ color: "var(--ms-faint)", marginLeft: 12 }}>
                      …
                    </span>
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
          <ListFooter
            left={t("list.pageOf", {
              pages: query.data?.pages.length ?? 1,
              total: nf.format(total),
            })}
            size={limit}
            onSize={setLimit}
            sizeLabel={(size) => t("list.pageSize", { count: size })}
          />
        </>
      )}
    </>
  );
}
