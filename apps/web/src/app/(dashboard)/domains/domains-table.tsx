"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { DomainStatusBadge, DomainTile } from "./domain-status";

function SkeletonRows() {
  const widths = [180, 120, 90];
  return (
    <tbody>
      {widths.map((width) => (
        <tr key={width}>
          {[0, 1, 2, 3].map((col) => (
            <td key={col}>
              <span
                style={{
                  display: "inline-block",
                  width: col === 0 ? width : 64,
                  height: 12,
                  borderRadius: "var(--ms-r-chip)",
                  background: "var(--ms-inset)",
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function DomainsTable() {
  const t = useTranslations("domains");
  const trpc = useTRPC();
  const domains = useQuery(trpc.domains.list.queryOptions());

  if (domains.isError) {
    return (
      <div
        className="ms-card"
        style={{ padding: "24px", display: "flex", gap: 14, alignItems: "center" }}
      >
        <p style={{ margin: 0, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
          {t("list.error")}
        </p>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={() => domains.refetch()}>
          {t("list.retry")}
        </button>
      </div>
    );
  }

  if (domains.isSuccess && domains.data.length === 0) {
    return <EmptyState headline={t("list.empty")} body={t("list.emptyBody")} />;
  }

  return (
    <Table>
      <thead>
        <tr>
          <th>{t("list.columns.domain")}</th>
          <th>{t("list.columns.status")}</th>
          <th>{t("list.columns.region")}</th>
          <th>{t("list.columns.created")}</th>
        </tr>
      </thead>
      {domains.isPending ? (
        <SkeletonRows />
      ) : (
        <tbody>
          {domains.data.map((domain) => (
            <tr key={domain.id}>
              <td>
                <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <DomainTile status={domain.status} />
                  <Link href={`/domains/${domain.id}`}>{domain.name}</Link>
                </span>
              </td>
              <td>
                <DomainStatusBadge status={domain.status} />
              </td>
              <td>
                <span className="ms-mono">{domain.region}</span>
              </td>
              <td>
                <RelativeTime date={domain.createdAt} />
              </td>
            </tr>
          ))}
        </tbody>
      )}
    </Table>
  );
}
