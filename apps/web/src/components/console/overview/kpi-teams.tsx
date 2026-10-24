"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { Period } from "@/components/console/chart-dialog";
import { LeadCell, SkeletonLead } from "@/components/lead-cell";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { mutedDash, Table } from "@/components/table";
import { TeamLogo } from "@/components/team-logo";
import { Tooltip } from "@/components/tooltip";
import { formatDay, formatDayTime, sameLocalDay } from "@/lib/format";
import { consoleReviewHref } from "@/lib/nav";
import { useTRPC } from "@/lib/trpc";
import { LINK_BUTTON } from "../safety/parts";
import { PlanBadge, TeamStatus } from "../teams/cells";
import { ChartNote, type FeedbackKind, kpiFormatter, pointLabel } from "./charts";

/** Rows shown before "Show all": what the 1318×900 dialog holds without scrolling. */
const VISIBLE = 7;
const COLUMNS = 8;

/** Mirrors a loaded row: logo and name, plan badge, day, status dot and word, three figures, day. */
function SkeletonRows() {
  return [120, 90, 140].map((width) => (
    <tr key={width}>
      <td>
        <SkeletonLead width={width} tile={22} />
      </td>
      <td>
        <SkeletonBadge width={52} />
      </td>
      <td>
        <Skeleton width={56} />
      </td>
      <td>
        <span aria-hidden="true" className="ms-dot ms-skeleton" style={{ marginRight: 8 }} />
        <Skeleton width={60} />
      </td>
      {[16, 40, 48].map((w) => (
        <td key={w} className="right">
          <Skeleton width={w} />
        </td>
      ))}
      <td>
        <Skeleton width={56} />
      </td>
    </tr>
  ));
}

/**
 * The teams behind the hard bounces or complaints a KPI dialog charts, over
 * its period: each team's count, sends and the card's own rate, most first.
 * A row opens the team's Trust & safety page, which holds every action.
 */
export function KpiTeams({ kind, period }: { kind: FeedbackKind; period: Period }) {
  const t = useTranslations("console.overview");
  const teams = useTranslations("console.teams");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.overview.kpiTeams.queryOptions({ kind, period }));
  const [all, setAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  // "Show all" leaves with its click: focus moves on to the first row it revealed.
  useEffect(() => {
    if (!all) return;
    list.current?.querySelector<HTMLElement>(`tbody tr:nth-child(${VISIBLE + 1}) a`)?.focus();
  }, [all]);
  const nf = new Intl.NumberFormat(locale);
  const rate = kpiFormatter(kind, locale);
  // A failed refetch keeps the last rows; the table says it failed instead.
  const data = query.isError ? undefined : query.data;
  const shown = data ? (all ? data.rows : data.rows.slice(0, VISIBLE)) : [];
  const hidden = data ? data.teams - shown.length : 0;
  const message = (text: React.ReactNode) => (
    <tr>
      <td colSpan={COLUMNS} style={{ color: "var(--ms-muted)", padding: "18px 12px" }}>
        {text}
      </td>
    </tr>
  );

  return (
    <>
      <div ref={list} style={{ marginTop: 20 }}>
        <Table className="nowrap baseline">
          <thead>
            <tr>
              <th style={{ width: "100%" }}>{teams("columns.team")}</th>
              <th>{teams("columns.type")}</th>
              <th>{teams("columns.created")}</th>
              <th>{t("kpiTeams.columns.status")}</th>
              <th className="right">{t(`kpi.${kind}`)}</th>
              <th className="right">{t("kpiTeams.columns.sent")}</th>
              <th className="right">{t("kpiTeams.columns.rate")}</th>
              <th>{t("kpiTeams.columns.last")}</th>
            </tr>
          </thead>
          <tbody>
            {query.isError ? (
              message(
                <>
                  {common("loadError")}{" "}
                  <button
                    type="button"
                    className="ms-link"
                    style={LINK_BUTTON}
                    onClick={() => void query.refetch()}
                  >
                    {common("retry")}
                  </button>
                </>,
              )
            ) : !data ? (
              <SkeletonRows />
            ) : data.rows.length === 0 ? (
              message(t("kpiTeams.empty", { kind }))
            ) : (
              shown.map((row) => {
                const href = consoleReviewHref(row.id);
                return (
                  <tr
                    key={row.id}
                    className="hoverable"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a, button")) return;
                      router.push(href);
                    }}
                  >
                    <LeadCell
                      tile={<TeamLogo name={row.name} logoUrl={row.logoUrl} size={22} />}
                      value={row.name}
                      href={href}
                    />
                    <td>
                      <PlanBadge plan={row.plan} planQuota={row.planQuota} />
                    </td>
                    <td style={{ color: "var(--ms-muted)" }}>{formatDay(row.createdAt, locale)}</td>
                    <td>
                      <TeamStatus team={row} />
                    </td>
                    <td className="right num">{nf.format(row.count)}</td>
                    <td className="right num">{nf.format(row.sent)}</td>
                    <td className="right num">
                      {row.rate === null ? (
                        <Tooltip
                          inline
                          text={t(row.sent === 0 ? "kpiTeams.lateNone" : "kpiTeams.lateSome", {
                            kind,
                          })}
                        >
                          {mutedDash}
                        </Tooltip>
                      ) : (
                        rate(row.rate)
                      )}
                    </td>
                    <td>
                      {/* A day's window starts in yesterday's hours: those carry their day. */}
                      {data.grain === "hour" && !sameLocalDay(row.lastAt, Date.now())
                        ? formatDayTime(row.lastAt, locale)
                        : pointLabel(row.lastAt, data.grain, locale)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </div>
      {data && data.rows.length > 0 ? (
        <ChartNote>
          {hidden === 0 ? (
            `${t("kpiTeams.teams", { count: data.teams })} · ${t("kpiTeams.events", { kind, count: data.total })}`
          ) : (
            <>
              {common("ofTeams", {
                shown: nf.format(shown.length),
                total: nf.format(data.teams),
              })}{" "}
              ·{" "}
              {t("kpiTeams.events", {
                kind,
                count: data.total - shown.reduce((sum, row) => sum + row.count, 0),
              })}{" "}
              {t("kpiTeams.others", { count: hidden })}
              {data.rows.length > shown.length ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="ms-link"
                    style={{ ...LINK_BUTTON, color: "var(--ms-bone)" }}
                    onClick={() => setAll(true)}
                  >
                    {t("kpiTeams.showAll")}
                  </button>
                </>
              ) : null}
            </>
          )}
        </ChartNote>
      ) : null}
    </>
  );
}
