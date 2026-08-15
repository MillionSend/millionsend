"use client";

import { useTranslations } from "next-intl";
import { DomainStatusBadge } from "@/app/(dashboard)/domains/domain-status";
import { CopyChip } from "@/components/copy-chip";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { Table } from "@/components/table";
import { zoneRelativeName } from "@/lib/zone";

const GROUPS = ["verification", "sending", "dmarc", "tracking"] as const;

/**
 * Rows per group as dnsRecordsForDomain emits them (packages/ses). Tracking is
 * 0 here: the branded-tracking CNAME only exists once a subdomain is set, so it
 * never appears in the loading skeleton.
 */
const GROUP_ROWS: Record<(typeof GROUPS)[number], number> = {
  verification: 1,
  sending: 2,
  dmarc: 1,
  tracking: 0,
};

export type LiveDnsStatus = "found" | "missing" | "mismatch";

export type DnsRecord = {
  group: (typeof GROUPS)[number];
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
  /** Live DNS verdict from the last Check DNS; absent until one runs. */
  live?: LiveDnsStatus | undefined;
};

const LIVE_BADGE: Record<LiveDnsStatus, string> = {
  found: "ms-badge-success",
  missing: "ms-badge-warn",
  mismatch: "ms-badge-danger",
};

/** Live DNS badge (Found / Missing / Mismatch), distinct from the SES status badge. */
function LiveDnsBadge({ status }: { status: LiveDnsStatus }) {
  const t = useTranslations("domains");
  return <span className={`ms-badge ${LIVE_BADGE[status]}`}>{t(`detail.live.${status}`)}</span>;
}

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
                    <td style={{ paddingRight: 24 }}>
                      <CopyChip value={record.value} />
                    </td>
                    <td>{t("detail.ttlAuto")}</td>
                    <td>{record.priority ?? "—"}</td>
                    {showStatus ? (
                      <td>
                        <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {record.status ? <DomainStatusBadge status={record.status} /> : null}
                          {record.live ? <LiveDnsBadge status={record.live} /> : null}
                          {!record.status && !record.live ? "—" : null}
                        </span>
                      </td>
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
      {GROUPS.filter((group) => GROUP_ROWS[group] > 0).map((group) => (
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
                <td style={{ paddingRight: 24 }}>
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
