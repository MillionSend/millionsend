"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "../audience-tabs";

function PropertiesHead() {
  const t = useTranslations("audience.properties");
  return (
    <thead>
      <tr>
        <th style={{ width: "34%" }}>{t("name")}</th>
        <th className="right" style={{ width: "26%" }}>
          {t("coverage")}
        </th>
        <th>{t("example")}</th>
      </tr>
    </thead>
  );
}

/** Mirrors the loaded table: mono key, a coverage figure, an example value. */
function PropertiesSkeleton() {
  return (
    <Table>
      <PropertiesHead />
      <tbody>
        {["38%", "52%", "44%"].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td className="right">
              <Skeleton width={64} height={13} />
            </td>
            <td>
              <Skeleton width="60%" height={13} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function PropertiesPage() {
  const t = useTranslations("audience.properties");
  const locale = useLocale();
  const trpc = useTRPC();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const pf = useMemo(() => new Intl.NumberFormat(locale, { style: "percent" }), [locale]);

  const query = useQuery(trpc.audience.properties.list.queryOptions());

  return (
    <>
      <PageHeader title={t("title")} />
      <AudienceTabs />

      {query.isPending ? (
        <PropertiesSkeleton />
      ) : query.isError ? (
        <div
          style={{
            border: "1px solid var(--ms-line)",
            borderRadius: 16,
            padding: 22,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t("loadError")}</div>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            style={{ marginTop: 12 }}
            onClick={() => query.refetch()}
          >
            {t("retry")}
          </button>
        </div>
      ) : query.data.length === 0 ? (
        <EmptyState area="audience" headline={t("empty")} body={t("emptyHint")} />
      ) : (
        <Table>
          <PropertiesHead />
          <tbody>
            {query.data.map((row) => (
              <tr key={row.key}>
                <td>
                  <span className="ms-mono" style={{ fontSize: 13, color: "var(--ms-bone)" }}>
                    {row.key}
                  </span>
                </td>
                <td className="right" style={{ color: "var(--ms-muted)" }}>
                  <span className="ms-mono" style={{ fontSize: 13 }}>
                    {nf.format(row.contactCount)} / {nf.format(row.totalContacts)}
                  </span>{" "}
                  <span style={{ color: "var(--ms-faint)", fontSize: 12.5 }}>
                    {pf.format(row.totalContacts > 0 ? row.contactCount / row.totalContacts : 0)}
                  </span>
                </td>
                <td>
                  <div
                    title={row.sampleValue}
                    style={{
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--ms-muted)",
                      fontSize: 13,
                    }}
                  >
                    {row.sampleValue}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
