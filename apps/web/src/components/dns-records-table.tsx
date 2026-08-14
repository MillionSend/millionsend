"use client";

import { useTranslations } from "next-intl";
import { DomainStatusBadge } from "@/app/(dashboard)/domains/domain-status";
import { CopyChip } from "@/components/copy-chip";
import { Table } from "@/components/table";

const GROUPS = ["verification", "sending", "dmarc"] as const;

export type DnsRecord = {
  group: (typeof GROUPS)[number];
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
};

/**
 * The grouped DNS-record tables (Domain verification / Enable sending / DMARC)
 * shared by the domain-detail page and the add-domain wizard's step 02.
 * Name/Content render as copy pills: end-ellipsis display, full value copied.
 */
export function DnsRecordsTable({
  records,
  showStatus = false,
}: {
  records: DnsRecord[];
  showStatus?: boolean;
}) {
  const t = useTranslations("domains");
  return (
    <div style={{ display: "grid", gap: 20 }}>
      {GROUPS.map((group) => {
        const rows = records.filter((r) => r.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} style={{ maxWidth: 1000 }}>
            <p className="ms-microlabel" style={{ margin: "0 0 8px" }}>
              {t(`detail.groups.${group}`)}
            </p>
            {/* tableLayout fixed so the pill cells can end-ellipsize long values. */}
            <Table className="ms-mono dense" style={{ fontSize: 13, tableLayout: "fixed" }}>
              <thead>
                <tr className="ms-mono">
                  <th style={{ width: 64 }}>{t("detail.columns.type")}</th>
                  <th style={{ width: "30%" }}>{t("detail.columns.name")}</th>
                  <th>{t("detail.columns.value")}</th>
                  <th style={{ width: 58 }}>{t("detail.columns.ttl")}</th>
                  <th style={{ width: 72 }}>{t("detail.columns.priority")}</th>
                  {showStatus ? <th style={{ width: 96 }}>{t("detail.columns.status")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((record) => (
                  <tr key={`${record.type}-${record.name}-${record.value}`}>
                    <td>{record.type}</td>
                    <td>
                      <CopyChip value={record.name} />
                    </td>
                    <td>
                      <CopyChip value={record.value} />
                    </td>
                    <td>{t("detail.ttlAuto")}</td>
                    <td>{record.priority ?? "—"}</td>
                    {showStatus ? (
                      <td>{record.status ? <DomainStatusBadge status={record.status} /> : "—"}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        );
      })}
    </div>
  );
}
