"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { type DomainStatus, DomainStatusBadge } from "./domain-status";
import { RegionLabel } from "./region-label";

function SkeletonRows() {
  const widths = [180, 120, 90];
  return (
    <tbody>
      {widths.map((width) => (
        <tr key={width}>
          {[0, 1, 2, 3].map((col) => (
            <td key={col} className={col === 3 ? "right" : undefined}>
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

const selectStyle: React.CSSProperties = { color: "var(--ms-muted)" };

export function DomainsView() {
  const t = useTranslations("domains");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const domains = useQuery(trpc.domains.list.queryOptions());

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [region, setRegion] = useState("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // The "/" keycap on the search input is a real shortcut, not decoration.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const rows = domains.data ?? [];
  const regions = useMemo(() => [...new Set(rows.map((d) => d.region))], [rows]);

  const filtered = rows.filter(
    (d) =>
      d.name.includes(search.trim().toLowerCase()) &&
      (status === "all" ||
        d.status === status ||
        (status === "pending" && d.status === "temporary_failure")) &&
      (region === "all" || d.region === region),
  );

  const summary = useMemo(() => {
    if (rows.length === 0) return undefined;
    const counts = { verified: 0, pending: 0, failed: 0 };
    for (const d of rows) {
      counts[d.status === "temporary_failure" ? "pending" : d.status] += 1;
    }
    const parts = (["verified", "pending", "failed"] as const)
      .filter((key) => counts[key] > 0)
      .map((key) => t(`list.summary.${key}`, { count: counts[key] }));
    parts.push(
      regions.length === 1 && regions[0]
        ? t("list.summary.allIn", { region: regions[0] })
        : t("list.summary.regions", { count: regions.length }),
    );
    return parts.join(" · ");
  }, [rows, regions, t]);

  return (
    <>
      <PageHeader
        title={t("list.title")}
        {...(summary ? { subtitle: summary } : {})}
        actions={
          <Link
            href="/domains/new"
            className="ms-btn ms-btn-primary"
            style={{ textDecoration: "none" }}
          >
            {t("list.addDomain")}
          </Link>
        }
      />

      {domains.isError ? (
        <div
          className="ms-card"
          style={{ padding: "24px", display: "flex", gap: 14, alignItems: "center" }}
        >
          <p style={{ margin: 0, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
            {t("list.error")}
          </p>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => domains.refetch()}
          >
            {t("list.retry")}
          </button>
        </div>
      ) : domains.isSuccess && rows.length === 0 ? (
        <EmptyState headline={t("list.empty")} body={t("list.emptyBody")} />
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}>
            <div style={{ position: "relative", width: 250 }}>
              <input
                ref={searchRef}
                type="text"
                className="ms-input"
                style={{ width: "100%", paddingRight: 32 }}
                placeholder={t("list.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="ms-keycap" style={{ position: "absolute", right: 8, top: 8 }}>
                /
              </span>
            </div>
            <select
              className="ms-input"
              style={selectStyle}
              aria-label={t("list.allStatuses")}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">{t("list.allStatuses")}</option>
              {(["verified", "pending", "failed"] as const).map((key) => (
                <option key={key} value={key}>
                  {common(`status.${key}`)}
                </option>
              ))}
            </select>
            <select
              className="ms-input"
              style={selectStyle}
              aria-label={t("list.allRegions")}
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            >
              <option value="all">{t("list.allRegions")}</option>
              {regions.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>

          <Table>
            <thead>
              <tr>
                <th style={{ width: "36%" }}>{t("list.columns.domain")}</th>
                <th style={{ width: "15%" }}>{t("list.columns.status")}</th>
                <th>{t("list.columns.region")}</th>
                <th className="right" style={{ width: "13%" }}>
                  {t("list.columns.created")}
                </th>
              </tr>
            </thead>
            {domains.isPending ? (
              <SkeletonRows />
            ) : (
              <tbody>
                {filtered.map((domain) => (
                  <tr key={domain.id}>
                    <td className="ms-mono" style={{ fontSize: 13 }}>
                      <Link href={`/domains/${domain.id}`}>{domain.name}</Link>
                    </td>
                    <td>
                      <DomainStatusBadge status={domain.status as DomainStatus} />
                    </td>
                    <td style={{ color: "var(--ms-muted)" }}>
                      <RegionLabel region={domain.region} />
                    </td>
                    <td className="right">
                      <RelativeTime date={domain.createdAt} />
                      <Link
                        href={`/domains/${domain.id}`}
                        aria-label={t("list.rowDetails")}
                        style={{
                          color: "var(--ms-faint)",
                          marginLeft: 12,
                          textDecoration: "none",
                        }}
                      >
                        …
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </Table>
          {domains.isSuccess ? (
            <div
              style={{
                marginTop: 14,
                fontSize: 13,
                color: "var(--ms-muted)",
              }}
            >
              {t("list.count", { count: filtered.length })}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
