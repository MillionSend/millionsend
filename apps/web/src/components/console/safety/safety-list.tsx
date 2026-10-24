"use client";

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { DOMAIN_REGIONS, regionFlag } from "@/app/(dashboard)/domains/regions";
import { ListFooter } from "@/components/list-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { SortableTh, type SortDir } from "@/components/sortable-th";
import { mutedDash, Table } from "@/components/table";
import { TeamLogo } from "@/components/team-logo";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { consoleReviewHref } from "@/lib/nav";
import { formatScoreTenths, scoreColor } from "@/lib/score-band";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { useTeamActions } from "../team-actions";
import { PlanBadge, TeamStatus } from "../teams/cells";
import { LimitRequests } from "./limit-requests";
import { FlagStatusBadge, LoadErrorCard, Rate7d, ReasonLabel, RegionCell, RiskCell } from "./parts";
import { useContentReveal } from "./reveal";
import { WaitingList } from "./waiting-list";

const STATUSES = ["open", "cleared", "suspended", "all"] as const;
// The team_flag_reason enum; tsc checks it against the router's input.
const REASONS = [
  "monitor",
  "complaints",
  "guardrail",
  "score",
  "report",
  "manual",
  "brand",
  "linked",
] as const;
const SORTS = ["name", "type", "risk", "score", "guardrail", "reason", "status", "since"] as const;
const DIRS = ["asc", "desc"] as const;
const COLUMNS = 12;

export function SafetyList() {
  const t = useTranslations("console.safety");
  const common = useTranslations("console.common");
  const domains = useTranslations("domains");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const client = useTRPCClient();

  const [search, setSearch] = useUrlState("q");
  const [statusParam, setStatus] = useUrlState("status", "open");
  const [reasonParam, setReason] = useUrlState("reason", "all");
  const [regionParam, setRegion] = useUrlState("region", "all");
  const [sortParam, setSort] = useUrlState("sort", "since");
  const [dirParam, setDir] = useUrlState("dir", "desc");
  const [limit, setLimit] = useState(25);
  const status = oneOf(STATUSES, statusParam, "open");
  const reason = oneOf(REASONS, reasonParam, "all");
  const region = oneOf(DOMAIN_REGIONS, regionParam, "all");
  const sort = oneOf(SORTS, sortParam, "since");
  const dir: SortDir = oneOf(DIRS, dirParam, "desc");
  const deferredSearch = useDeferredValue(search.trim());

  const input = {
    status,
    sort,
    dir,
    limit,
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(reason !== "all" ? { reason } : {}),
    ...(region !== "all" ? { region } : {}),
  };
  // Offset paging: the router pages by offset, which tRPC's cursor-only
  // infiniteQueryOptions cannot express, so the pages are fetched by hand. The
  // suffix keeps the pages apart from a plain query of the same input.
  const query = useInfiniteQuery({
    queryKey: [...trpc.console.safety.list.queryKey(input), "infinite"],
    queryFn: ({ pageParam }) => client.console.safety.list.query({ ...input, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const first = query.data?.pages[0];
  const counts = first?.counts ?? {
    open: 0,
    guardrailPaused: 0,
    suspended: 0,
    revealsThisWeek: 0,
  };
  const contentReveal = first?.contentReveal ?? false;

  const refetch = () => {
    query.refetch();
  };
  const actions = useTeamActions(refetch);
  const reveal = useContentReveal({ onChanged: refetch });
  const clear = useMutation(trpc.console.safety.clearFlag.mutationOptions());
  const reopen = useMutation(trpc.console.safety.reopenFlag.mutationOptions());
  const done = (key: "cleared" | "reopened", team: string) => () => {
    toast(t(`toast.${key}`, { team }));
    refetch();
  };

  const onSort = (column: string, next: SortDir) => {
    setSort(column);
    setDir(next);
  };
  const th = (column: (typeof SORTS)[number], defaultDir: SortDir = "asc", right = false) => (
    <SortableTh
      column={column}
      label={t(`columns.${column === "name" ? "team" : column}`)}
      sort={sort}
      dir={dir}
      onSort={onSort}
      defaultDir={defaultDir}
      right={right}
    />
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("proof", counts)}
        titleAdornment={<Tooltip text={t("info")} />}
        actions={
          <Link href="/console/safety/settings" className="ms-btn ms-btn-secondary">
            {t("settingsButton")}
          </Link>
        }
      />
      <LimitRequests />
      <WaitingList onChanged={refetch} />
      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <input
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            placeholder={t("search")}
            aria-label={t("search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          value={status}
          onChange={setStatus}
          width={160}
          ariaLabel={t("filters.status", { value: t(`status.${status}`) })}
          options={STATUSES.map((s) => ({
            value: s,
            label: t("filters.status", { value: t(`status.${s}`) }),
          }))}
        />
        <Select
          value={reason}
          onChange={setReason}
          width={160}
          ariaLabel={t("filters.reason", {
            value: reason === "all" ? t("filters.all") : t(`reasons.${reason}`),
          })}
          options={[
            { value: "all", label: t("filters.reason", { value: t("filters.all") }) },
            ...REASONS.map((r) => ({
              value: r,
              label: t("filters.reason", { value: t(`reasons.${r}`) }),
            })),
          ]}
        />
        <Select
          value={region}
          onChange={setRegion}
          width={180}
          ariaLabel={t("filters.region", {
            value: region === "all" ? t("filters.all") : domains(`regions.${region}`),
          })}
          options={[
            { value: "all", label: t("filters.region", { value: t("filters.all") }) },
            ...DOMAIN_REGIONS.map((r) => ({
              value: r,
              label: t("filters.region", {
                value: `${regionFlag(r)} ${domains(`regions.${r}`)}`,
              }),
            })),
          ]}
        />
      </div>

      {query.isError ? (
        <LoadErrorCard onRetry={refetch} />
      ) : (
        <>
          <div className="ms-card" style={{ padding: 0 }}>
            <Table className="nowrap baseline">
              <thead>
                <tr>
                  {th("name")}
                  {th("type")}
                  <SortableTh
                    column="risk"
                    label={t("columns.risk")}
                    sort={sort}
                    dir={dir}
                    onSort={onSort}
                    defaultDir="desc"
                    right
                  />
                  {th("score", "desc", true)}
                  <th className="right">{t("columns.complaints")}</th>
                  <th className="right">{t("columns.bounces")}</th>
                  {th("guardrail")}
                  {th("reason")}
                  {th("status")}
                  <th>{t("columns.region")}</th>
                  {th("since", "desc")}
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.isPending ? (
                  <SkeletonRows />
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS} style={{ color: "var(--ms-muted)" }}>
                      {t("empty")}
                    </td>
                  </tr>
                ) : (
                  items.map((row) => {
                    const target = {
                      id: row.teamId,
                      name: row.name,
                      plan: row.plan,
                      planQuota: row.planQuota,
                      suspendedAt: row.suspendedAt,
                      broadcastsPausedByOperatorAt: row.broadcastsPausedByOperatorAt,
                    };
                    const href = consoleReviewHref(row.teamId);
                    return (
                      <tr
                        key={row.id}
                        className="hoverable"
                        style={{ cursor: "pointer" }}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("button")) return;
                          router.push(href);
                        }}
                      >
                        <td>
                          <span className="ms-lead" style={{ gap: 8 }}>
                            <TeamLogo name={row.name} logoUrl={row.logoUrl} size={22} />
                            {row.name}
                          </span>
                        </td>
                        <td>
                          <PlanBadge plan={row.plan} planQuota={row.planQuota} />
                        </td>
                        <td className="right num">
                          <Tooltip inline text={t("riskTip")}>
                            <RiskCell
                              risk={row.monitorRisk}
                              plan={row.plan}
                              thresholds={first?.thresholds}
                            />
                          </Tooltip>
                        </td>
                        <td
                          className="right num"
                          style={{
                            color:
                              row.scoreTenths === null ? undefined : scoreColor(row.scoreTenths),
                          }}
                        >
                          {row.scoreTenths === null
                            ? mutedDash
                            : formatScoreTenths(row.scoreTenths, locale)}
                        </td>
                        <td className="right num">
                          <Rate7d
                            rate={row.complaintRate7d}
                            sent={row.sent7d ?? 0}
                            complaintSends={row.complaintSends7d}
                          />
                        </td>
                        <td className="right num">
                          <Rate7d rate={row.hardBounceRate7d} sent={row.sent7d ?? 0} />
                        </td>
                        <td style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
                          <TeamStatus team={row} />
                        </td>
                        <td style={{ maxWidth: 180 }}>
                          <ReasonLabel reason={row.reason} detail={row.detail} truncate />
                        </td>
                        <td>
                          <FlagStatusBadge status={row.status} suspendedAt={row.suspendedAt} />
                        </td>
                        <td>
                          <RegionCell region={row.region} />
                        </td>
                        <td style={{ color: "var(--ms-muted)" }}>
                          <RelativeTime date={row.openedAt} />
                        </td>
                        <td className="right ms-cell-menu" style={{ width: 40 }}>
                          <PopoverMenu
                            ariaLabel={common("actions")}
                            items={[
                              { label: t("menu.review"), onSelect: () => router.push(href) },
                              ...(contentReveal
                                ? [
                                    {
                                      label: t("menu.reveal"),
                                      onSelect: () =>
                                        reveal.request({
                                          team: { id: row.teamId, name: row.name },
                                          email: null,
                                          flaggedCount: 0,
                                          flagLabel: t(`reasons.${row.reason}`),
                                        }),
                                    },
                                  ]
                                : []),
                              row.broadcastsPausedByOperatorAt
                                ? {
                                    label: t("menu.resume"),
                                    onSelect: () => actions.resumeBroadcasts(target),
                                  }
                                : {
                                    label: t("menu.pause"),
                                    onSelect: () => actions.pauseBroadcasts(target),
                                  },
                              null,
                              row.status === "open"
                                ? {
                                    label: t("menu.clear"),
                                    onSelect: () =>
                                      clear.mutate(
                                        { flagId: row.id },
                                        { onSuccess: done("cleared", row.name) },
                                      ),
                                  }
                                : {
                                    label: t("menu.reopen"),
                                    onSelect: () =>
                                      reopen.mutate(
                                        { flagId: row.id },
                                        { onSuccess: done("reopened", row.name) },
                                      ),
                                  },
                              row.suspendedAt
                                ? {
                                    label: t("menu.reinstate"),
                                    onSelect: () => actions.reinstate(target),
                                  }
                                : {
                                    label: t("menu.suspend"),
                                    danger: true,
                                    onSelect: () => actions.suspend(target),
                                  },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </Table>
          </div>
          {first ? (
            <ListFooter
              left={t("count", { shown: items.length, total: first.total })}
              size={limit}
              onSize={setLimit}
              sizeLabel={(size) => common("perPage", { n: size })}
              singlePage={!query.hasNextPage && query.data?.pages.length === 1}
              loadMore={
                query.hasNextPage
                  ? {
                      label: common("loadMore"),
                      onClick: () => query.fetchNextPage(),
                      loading: query.isFetchingNextPage,
                    }
                  : undefined
              }
            />
          ) : null}
        </>
      )}
      {actions.dialogs}
      {reveal.dialogs}
    </>
  );
}

/** Mirrors a loaded row: logo + name, plan badge, figures, dots, badges, time, the menu glyph. */
function SkeletonRows() {
  const widths = [140, 110, 160, 120, 130];
  return widths.map((width) => (
    <tr key={width}>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Skeleton width={22} height={22} radius={7} />
          <Skeleton width={width} height={13} />
        </span>
      </td>
      <td>
        <SkeletonBadge width={56} />
      </td>
      <td className="right">
        <Skeleton width={32} />
      </td>
      <td className="right">
        <Skeleton width={28} />
      </td>
      <td className="right">
        <Skeleton width={44} />
      </td>
      <td className="right">
        <Skeleton width={44} />
      </td>
      <td>
        <Skeleton width={60} />
      </td>
      <td>
        <Skeleton width={150} />
      </td>
      <td>
        <SkeletonBadge width={52} />
      </td>
      <td>
        <Skeleton width={90} />
      </td>
      <td>
        <Skeleton width={48} />
      </td>
      <td className="right" style={{ width: 40 }}>
        <Skeleton width={28} height={28} radius={8} />
      </td>
    </tr>
  ));
}
