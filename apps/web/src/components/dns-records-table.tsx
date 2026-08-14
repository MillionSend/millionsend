"use client";

import { useTranslations } from "next-intl";
import { DomainStatusBadge } from "@/app/(dashboard)/domains/domain-status";
import { CopyChip } from "@/components/copy-chip";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { Table } from "@/components/table";
import { zoneRelativeName } from "@/lib/zone";

const GROUPS = ["verification", "sending", "dmarc"] as const;

/** Rows per group as dnsRecordsForDomain emits them (packages/ses). */
const GROUP_ROWS: Record<(typeof GROUPS)[number], number> = {
  verification: 1,
  sending: 2,
  dmarc: 1,
};

export type DnsRecord = {
  group: (typeof GROUPS)[number];
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
};

function RecordsTable({
  children,
  showStatus,
}: {
  children: React.ReactNode;
  showStatus: boolean;
}) {
  const t = useTranslations("domains");
  return (
    /* tableLayout fixed so the pill cells can end-ellipsize long values. */
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
      <tbody>{children}</tbody>
    </Table>
  );
}

/**
 * The grouped DNS-record tables (Domain verification / Enable sending / DMARC)
 * shared by the domain-detail page and the add-domain wizard's step 02.
 * The Name pill shows and copies the zone-relative name (what a DNS
 * provider's Name field expects); the full hostname rides in the title.
 * Content pills end-ellipsize; the full value is copied.
 */
export function DnsRecordsTable({
  records,
  domain,
  showStatus = false,
}: {
  records: DnsRecord[];
  /** The domain the records belong to; omitted, names render absolute. */
  domain?: string | undefined;
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
            <RecordsTable showStatus={showStatus}>
              {rows.map((record) => {
                const name = domain ? zoneRelativeName(record.name, domain) : record.name;
                return (
                  <tr key={`${record.type}-${record.name}-${record.value}`}>
                    <td>{record.type}</td>
                    <td>
                      <CopyChip value={name} title={record.name} />
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
                );
              })}
            </RecordsTable>
          </div>
        );
      })}
    </div>
  );
}

/** Loading stand-in mirroring the real grouped tables: same headings, columns and row counts. */
export function DnsRecordsTableSkeleton({ showStatus = false }: { showStatus?: boolean }) {
  const t = useTranslations("domains");
  return (
    <div style={{ display: "grid", gap: 20 }}>
      {GROUPS.map((group) => (
        <div key={group} style={{ maxWidth: 1000 }}>
          <p className="ms-microlabel" style={{ margin: "0 0 8px" }}>
            {t(`detail.groups.${group}`)}
          </p>
          <RecordsTable showStatus={showStatus}>
            {Array.from({ length: GROUP_ROWS[group] }, (_, row) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows, position is identity
              <tr key={row}>
                <td>
                  <Skeleton width={32} />
                </td>
                <td>
                  <SkeletonChip width="85%" />
                </td>
                <td>
                  <SkeletonChip width="95%" />
                </td>
                <td>
                  <Skeleton width={32} />
                </td>
                <td>
                  <Skeleton width={20} />
                </td>
                {showStatus ? (
                  <td>
                    <SkeletonBadge />
                  </td>
                ) : null}
              </tr>
            ))}
          </RecordsTable>
        </div>
      ))}
    </div>
  );
}
