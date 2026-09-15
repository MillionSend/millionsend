"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState } from "react";
import { DOMAIN_REGIONS, regionFlag } from "@/app/(dashboard)/domains/regions";
import { teamMenuItems, useTeamActions } from "@/components/console/team-actions";
import { ListFooter } from "@/components/list-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { SortableTh, type SortDir } from "@/components/sortable-th";
import { StatusDot } from "@/components/status-badge";
import { Table } from "@/components/table";
import { TeamLogo } from "@/components/team-logo";
import { formatDay } from "@/lib/format";
import { formatScoreTenths } from "@/lib/score-band";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { GuardrailLabel, PlanBadge, RegionLabel, usePlanName } from "./cells";
import type { TeamRow } from "./types";

const SORT_KEYS = [
  "name",
  "type",
  "domains",
  "contacts",
  "sent30d",
  "score",
  "guardrail",
  "created",
] as const;
const GUARDRAILS = ["ok", "warning", "paused"] as const;
const TEAM_TYPES = ["free", "starter", "pro", "scale", "system"] as const;
const GUARDRAIL_COLOR = {
  ok: "var(--ms-success)",
  warning: "var(--ms-warn)",
  paused: "var(--ms-danger)",
} as const;
const COLUMNS = 11;

function scoreColor(tenths: number): string | undefined {
  if (tenths < 50) return "var(--ms-danger)";
  if (tenths < 70) return "var(--ms-warn)";
  return undefined;
}

/** Mirrors a loaded row: logo + name, badge, muted email, four figures, dot label, region, day, menu. */
function SkeletonRows() {
  return (
    <tbody>
      {[150, 110, 170, 130, 120, 160].map((width) => (
        <tr key={width}>
          <td>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Skeleton width={22} height={22} radius={7} />
              <Skeleton width={width} height={13} />
            </span>
          </td>
          <td>
            <SkeletonBadge width={52} />
          </td>
          <td>
            <Skeleton width={140} />
          </td>
          {[28, 48, 56, 28].map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells, position is identity
            <td key={i} className="right">
              <Skeleton width={w} />
            </td>
          ))}
          <td>
            <Skeleton width={64} />
          </td>
          <td>
            <Skeleton width={90} />
          </td>
          <td>
            <Skeleton width={44} />
          </td>
          <td className="right">
            <Skeleton width={28} height={28} radius={8} />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

export function TeamsView() {
  const t = useTranslations("console.teams");
  const common = useTranslations("console.common");
  const domains = useTranslations("domains");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const planName = usePlanName();
  const trpc = useTRPC();
  const client = useTRPCClient();

  const [search, setSearch] = useUrlState("q");
  const [typeParam, setType] = useUrlState("type", "all");
  const [regionParam, setRegion] = useUrlState("region", "all");
  const [guardrailParam, setGuardrail] = useUrlState("guardrail", "all");
  const [sortParam, setSort] = useUrlState("sort", "sent30d");
  const [dirParam, setDir] = useUrlState("dir", "desc");
  const [limit, setLimit] = useState(25);
  const deferredSearch = useDeferredValue(search.trim());

  // URL params are untrusted: anything outside the router's enums reads as the default.
  const guardrail = oneOf(GUARDRAILS, guardrailParam, "all");
  const sort = oneOf(SORT_KEYS, sortParam, "sent30d");
  const dir: SortDir = oneOf(["asc", "desc"] as const, dirParam, "desc");
  const region = oneOf(DOMAIN_REGIONS, regionParam, "all");
  const type = oneOf(TEAM_TYPES, typeParam, "all");

  const input = {
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(type !== "all" ? { type } : {}),
    ...(region !== "all" ? { region } : {}),
    ...(guardrail !== "all" ? { guardrail } : {}),
    sort,
    dir,
    limit,
  };
  // The router pages by offset, which tRPC's infinite helper (cursor-only) cannot drive.
  const list = useInfiniteQuery({
    queryKey: [...trpc.console.teams.list.queryKey(input), "infinite"],
    queryFn: ({ pageParam }) => client.console.teams.list.query({ ...input, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset,
  });
  const summary = useQuery(trpc.console.overview.summary.queryOptions());
  const actions = useTeamActions(() => {
    void list.refetch();
    void summary.refetch();
  });

  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const plans = useMemo(
    () => [...new Set((list.data?.pages[0]?.rungs ?? []).map((r) => r.plan))],
    [list.data?.pages],
  );

  const onSort = (column: string, next: SortDir) => {
    setSort(column);
    setDir(next);
  };
  const sortable = (column: (typeof SORT_KEYS)[number], right = false, defaultDir?: SortDir) => (
    <SortableTh
      column={column}
      label={t(`columns.${column === "name" ? "team" : column}`)}
      sort={sort}
      dir={dir}
      onSort={onSort}
      right={right}
      {...(defaultDir ? { defaultDir } : {})}
    />
  );

  const proof = summary.data
    ? t("proof", {
        total: nf.format(summary.data.teams.total),
        free: nf.format(summary.data.teams.free),
        paid: nf.format(summary.data.teams.paid),
        system: nf.format(summary.data.teams.system),
        suspended: nf.format(summary.data.teams.suspended),
      })
    : undefined;

  function openRow(event: React.MouseEvent, row: TeamRow) {
    if ((event.target as HTMLElement).closest("button, a")) return;
    actions.openTeam(row);
  }

  return (
    <>
      <PageHeader title={t("title")} {...(proof ? { subtitle: proof } : {})} />

      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <div style={{ flex: 1, minWidth: 160 }}>
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
          value={plans.includes(type) ? type : "all"}
          onChange={setType}
          ariaLabel={t("columns.type")}
          options={[
            { value: "all", label: t("filters.type", { value: t("filters.all") }) },
            ...plans.map((plan) => ({
              value: plan,
              label: t("filters.type", { value: planName(plan) }),
            })),
          ]}
        />
        <Select
          value={region}
          onChange={setRegion}
          ariaLabel={t("columns.region")}
          options={[
            { value: "all", label: t("filters.region", { value: t("filters.all") }) },
            ...DOMAIN_REGIONS.map((code) => ({
              value: code,
              label: t("filters.region", {
                value: `${regionFlag(code)} ${domains(`regions.${code}`)}`,
              }),
            })),
          ]}
        />
        <Select
          value={guardrail}
          onChange={setGuardrail}
          ariaLabel={t("columns.guardrail")}
          options={[
            {
              value: "all",
              label: t("filters.guardrail", { value: t("filters.all") }),
              adornment: <StatusDot />,
            },
            ...GUARDRAILS.map((key) => ({
              value: key,
              label: t("filters.guardrail", { value: t(`guardrail.${key}`) }),
              adornment: <StatusDot color={GUARDRAIL_COLOR[key]} />,
            })),
          ]}
        />
      </div>

      {list.isError ? (
        <div
          className="ms-card"
          style={{ padding: 24, display: "flex", gap: 14, alignItems: "center" }}
        >
          <p style={{ margin: 0, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
            {common("loadError")}
          </p>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => list.refetch()}>
            {common("retry")}
          </button>
        </div>
      ) : (
        <div className="ms-card" style={{ padding: 0, overflow: "hidden" }}>
          <Table className="nowrap">
            <thead>
              <tr>
                {sortable("name", false, "asc")}
                {sortable("type")}
                <th>{t("columns.owner")}</th>
                {sortable("domains", true)}
                {sortable("contacts", true)}
                {sortable("sent30d", true)}
                {sortable("score", true)}
                {sortable("guardrail")}
                <th>{t("columns.region")}</th>
                {sortable("created")}
                <th />
              </tr>
            </thead>
            {list.isPending ? (
              <SkeletonRows />
            ) : (
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={COLUMNS}
                      style={{ color: "var(--ms-muted)", padding: "18px 12px" }}
                    >
                      {t("empty")}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} className="hoverable" onClick={(event) => openRow(event, row)}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <TeamLogo name={row.name} logoUrl={row.logoUrl} size={22} />
                          {row.name}
                        </span>
                      </td>
                      <td>
                        <PlanBadge plan={row.plan} planQuota={row.planQuota} />
                      </td>
                      <td
                        title={row.ownerEmail ?? undefined}
                        style={{
                          color: "var(--ms-muted)",
                          maxWidth: 170,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {row.ownerEmail ?? common("none")}
                      </td>
                      <td className="right num">{nf.format(row.domains)}</td>
                      <td className="right num">{nf.format(row.contacts)}</td>
                      <td
                        className="right num"
                        style={row.sent30d === null ? { color: "var(--ms-muted)" } : undefined}
                      >
                        {row.sent30d === null ? common("none") : nf.format(row.sent30d)}
                      </td>
                      <td
                        className="right num"
                        style={{
                          color:
                            row.scoreTenths === null
                              ? "var(--ms-muted)"
                              : scoreColor(row.scoreTenths),
                        }}
                      >
                        {row.scoreTenths === null
                          ? common("none")
                          : formatScoreTenths(row.scoreTenths, locale)}
                      </td>
                      <td>
                        <GuardrailLabel
                          guardrail={row.guardrail}
                          suspendedAt={row.suspendedAt}
                          broadcastsPausedByOperatorAt={row.broadcastsPausedByOperatorAt}
                        />
                      </td>
                      <td>
                        <RegionLabel region={row.region} />
                      </td>
                      <td style={{ color: "var(--ms-muted)" }}>
                        {formatDay(row.createdAt, locale)}
                      </td>
                      <td className="right" style={{ width: 40 }}>
                        <PopoverMenu
                          ariaLabel={common("actions")}
                          items={teamMenuItems(row, actions, (key) => t(`menu.${key}`))}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </Table>
          {list.isSuccess ? (
            <div style={{ padding: "0 16px 14px", borderTop: "1px solid var(--ms-line)" }}>
              <ListFooter
                left={common("ofTeams", { shown: nf.format(rows.length), total: nf.format(total) })}
                size={limit}
                onSize={setLimit}
                sizeLabel={(size) => common("perPage", { n: size })}
                singlePage={!list.hasNextPage && list.data.pages.length === 1}
                loadMore={
                  list.hasNextPage
                    ? {
                        label: common("loadMore"),
                        onClick: () => void list.fetchNextPage(),
                        loading: list.isFetchingNextPage,
                      }
                    : undefined
                }
              />
            </div>
          ) : null}
        </div>
      )}

      {actions.dialogs}
    </>
  );
}
