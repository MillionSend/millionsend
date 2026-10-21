"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { TeamLogo } from "@/components/team-logo";
import { consoleReviewHref } from "@/lib/nav";
import { useTRPC } from "@/lib/trpc";
import { CardHead } from "./parts";

/**
 * The teams asking to lift a new domain's limit, newest first, each one
 * answered with Trust or Decline on its team's page. Renders nothing while
 * no request is open.
 */
export function LimitRequests() {
  const t = useTranslations("console.safety.limitRequests");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const trpc = useTRPC();
  const requests = useQuery(trpc.console.safety.limitRequests.queryOptions()).data ?? [];
  if (requests.length === 0) return null;
  return (
    <div className="ms-card ms-card-table" style={{ marginBottom: 16 }}>
      <CardHead inset title={t("title", { count: requests.length })} subtitle={t("subtitle")} />
      <Table className="nowrap">
        <thead>
          <tr>
            <th>{t("cols.team")}</th>
            <th>{t("cols.domain")}</th>
            <th className="right">{t("cols.perDay")}</th>
            <th>{t("cols.sends")}</th>
            <th>{t("cols.source")}</th>
            <th className="right">{t("cols.waiting")}</th>
            <th>{t("cols.since")}</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <TeamLogo name={request.team} logoUrl={request.logoUrl} size={22} />
                  <Link href={consoleReviewHref(request.teamId)}>{request.team}</Link>
                </span>
              </td>
              <td className="ms-mono">{request.domain}</td>
              <td className="right num">{nf.format(request.perDay)}</td>
              <td>{t(`sends.${request.sends}`)}</td>
              <td>{t(`source.${request.source}`)}</td>
              <td className="right num">{nf.format(request.waiting)}</td>
              <td>
                <RelativeTime date={request.createdAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
