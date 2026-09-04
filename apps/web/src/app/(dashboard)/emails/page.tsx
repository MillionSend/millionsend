"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState } from "react";
import { ApiDocsButton } from "@/components/api-sheet";
import { EmailsTable } from "@/components/emails-table";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvLink } from "@/components/export-csv-link";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { StatusDot } from "@/components/status-badge";
import { codeRichTags } from "@/lib/code-rich-tags";
import { formatHoursMinutes } from "@/lib/format";
import { type RangeKey, rangeSince } from "@/lib/list-range";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { ListFooter, ListSkeleton, SearchBox, StateCard } from "./list-parts";

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
  const _router = useRouter();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [search, setSearch] = useUrlState("q");
  const [statusParam, setStatus] = useUrlState("status", "all");
  const [rangeParam, setRange] = useUrlState("range", "d15");
  const [apiKeyId, setApiKeyId] = useUrlState("key", "all");
  const [domainId, setDomainId] = useUrlState("domain", "all");
  const [limit, setLimit] = useState(40);
  const status: EmailStatus | "all" = oneOf(STATUSES, statusParam, "all");
  const range: RangeKey = oneOf(RANGE_KEYS, rangeParam, "d15");
  const deferredSearch = useDeferredValue(search.trim());
  const since = useMemo(() => rangeSince(range), [range]);

  const query = useInfiniteQuery(
    trpc.emails.list.infiniteQueryOptions(
      {
        limit,
        ...(status !== "all" ? { status } : {}),
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(apiKeyId !== "all" ? { apiKeyId } : {}),
        ...(domainId !== "all" ? { domainId } : {}),
        ...(since ? { since } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const stats = useQuery(trpc.emails.stats.queryOptions());
  const usage = useQuery(trpc.settings.usage.recent.queryOptions({}));
  const apiKeys = useQuery(trpc.apiKeys.list.queryOptions());
  const domains = useQuery(trpc.domains.list.queryOptions());
  const teamList = useQuery(trpc.team.list.queryOptions());
  const role = teamList.data?.teams.find((m) => m.teamId === teamList.data?.activeTeamId)?.role;
  const canExport = role === "owner" || role === "admin";

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  const capReached =
    usage.data?.today.limit != null && usage.data.today.accepted >= usage.data.today.limit;

  const hasFilters =
    deferredSearch !== "" ||
    status !== "all" ||
    apiKeyId !== "all" ||
    domainId !== "all" ||
    range !== "all";
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
    setDomainId("all");
    setRange("all");
  }

  const exportParams = new URLSearchParams();
  if (deferredSearch) exportParams.set("search", deferredSearch);
  if (status !== "all") exportParams.set("status", status);
  if (apiKeyId !== "all") exportParams.set("apiKeyId", apiKeyId);
  if (domainId !== "all") exportParams.set("domainId", domainId);
  if (since) exportParams.set("since", since.toISOString());
  const exportQuery = exportParams.toString();

  const filterSummary = [
    ...(deferredSearch ? [`"${deferredSearch}"`] : []),
    ...(status !== "all" ? [t("list.statusFilter", { status: common(`status.${status}`) })] : []),
    ...(range !== "all" ? [t(`list.range.${range}`)] : []),
  ].join(" · ");

  return (
    <>
      <PageHeader
        title={t("list.title")}
        actions={
          <>
            {canExport ? (
              <ExportCsvLink
                href={exportQuery ? `/export/emails?${exportQuery}` : "/export/emails"}
              />
            ) : null}
            <Link className="ms-btn ms-btn-secondary" href="/emails/suppressions">
              {t("list.suppressionList")}
            </Link>
            <ApiDocsButton />
          </>
        }
      />

      {capReached && usage.data?.today.limit != null ? (
        <div
          className="ms-wrap-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            backgroundColor: "var(--ms-ground)",
            backgroundImage: statusGlow("warn"),
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
          {/* A daily limit exists only on the hosted cloud, so the billing page always exists here. */}
          <Link
            href="/settings/billing"
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

      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <SearchBox value={search} onChange={setSearch} placeholder={t("list.searchPlaceholder")} />
        <Select
          value={range}
          onChange={setRange}
          width={160}
          ariaLabel={t(`list.range.${range}`)}
          options={RANGE_KEYS.map((key) => ({ value: key, label: t(`list.range.${key}`) }))}
        />
        <Select
          value={status}
          onChange={setStatus}
          width={156}
          ariaLabel={t("list.status")}
          options={[
            { value: "all", label: t("list.allStatuses"), adornment: <StatusDot /> },
            ...STATUSES.map((s) => ({
              value: s,
              label: common(`status.${s}`),
              adornment: <StatusDot status={s} />,
            })),
          ]}
        />
        <Select
          value={apiKeyId}
          onChange={setApiKeyId}
          width={200}
          ariaLabel={t("list.allApiKeys")}
          options={[
            { value: "all", label: t("list.allApiKeys") },
            ...(apiKeys.data ?? []).map((key) => ({ value: key.id, label: key.name })),
          ]}
        />
        {/* One domain gives the filter nothing to choose between. */}
        {(domains.data ?? []).length > 1 ? (
          <Select
            value={domainId}
            onChange={setDomainId}
            width={200}
            ariaLabel={t("list.allDomains")}
            options={[
              { value: "all", label: t("list.allDomains") },
              ...(domains.data ?? []).map((domain) => ({ value: domain.id, label: domain.name })),
            ]}
          />
        ) : null}
      </div>

      {query.isPending ? (
        <ListSkeleton
          headers={[t("list.to"), t("list.status"), t("list.subject"), t("list.sent")]}
        />
      ) : query.isError ? (
        <StateCard
          tone="error"
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
          <EmptyState
            area="emails"
            headline={t("list.empty")}
            body={t.rich("list.emptyHint", codeRichTags)}
          />
        )
      ) : (
        <>
          <EmailsTable rows={items} />
          <ListFooter
            left={t("list.pageOf", {
              pages: query.data?.pages.length ?? 1,
              total: nf.format(total),
            })}
            size={limit}
            onSize={setLimit}
            sizeLabel={(size) => t("list.pageSize", { count: size })}
            singlePage={!query.hasNextPage && (query.data?.pages.length ?? 1) === 1}
            loadMore={
              query.hasNextPage
                ? {
                    label: t("list.loadMore"),
                    onClick: () => query.fetchNextPage(),
                    loading: query.isFetchingNextPage,
                  }
                : undefined
            }
          />
        </>
      )}
    </>
  );
}
