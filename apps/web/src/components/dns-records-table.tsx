"use client";

import { useTranslations } from "next-intl";
import { CopyChip } from "@/components/copy-chip";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { codeRichTags } from "@/lib/code-rich-tags";
import {
  combineRecordStatus,
  type LiveDnsStatus,
  type RecordStatus,
  sesGateFromRecordStatus,
} from "@/lib/dns-record-status";
import { abbreviateDkim } from "@/lib/format";
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

export type DnsRecord = {
  group: (typeof GROUPS)[number];
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
  /** Live DNS verdict: from the last Check DNS, or served with the records for rows SES never checks. */
  live?: LiveDnsStatus | undefined;
  /** On a live mismatch: what the name answered instead, one answer per line. */
  found?: string | undefined;
  /** Set when this name is empty but a parent record governs it (DMARC organizational-domain fallback). */
  inherited?: { name: string; policy: string } | undefined;
};

// verified reads success; a record still pending at AWS or missing/wrong in our
// lookup warns; a present-but-wrong record is the danger case.
const RECORD_STATUS_TONE: Record<RecordStatus, string> = {
  verified: "ms-badge-success",
  pending: "ms-badge-warn",
  missing: "ms-badge-warn",
  mismatch: "ms-badge-danger",
};

/**
 * The single source-of-truth Status badge: our live DNS lookup gated by AWS's
 * verification. Sized to its label (inline-block) — never stretched to the cell.
 */
function RecordStatusBadge({ status, note }: { status: RecordStatus; note?: React.ReactNode }) {
  const t = useTranslations("domains");
  return (
    <span
      className={`ms-badge ${RECORD_STATUS_TONE[status]}`}
      style={note ? { display: "inline-flex", alignItems: "center", gap: 4 } : undefined}
    >
      {t(`detail.recordStatus.${status}`)}
      {note ? <Tooltip text={note} /> : null}
    </span>
  );
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
  highlightGroup = null,
  forceGroups = [],
  groupExtras = {},
  emptyNotes = {},
}: {
  records: DnsRecord[];
  /** The domain the records belong to; omitted, names render absolute. */
  domain?: string | undefined;
  showStatus?: boolean;
  /** One-shot attention pulse + scroll anchor for a group the user was sent to. */
  highlightGroup?: (typeof GROUPS)[number] | null;
  /** Groups rendered even with no records (their emptyNotes line shows instead). */
  forceGroups?: (typeof GROUPS)[number][];
  /** Right-aligned header content per group (e.g. a toggle). */
  groupExtras?: Partial<Record<(typeof GROUPS)[number], React.ReactNode>>;
  emptyNotes?: Partial<Record<(typeof GROUPS)[number], string>>;
}) {
  const t = useTranslations("domains");
  return (
    <div style={{ display: "grid", gap: 20 }}>
      {GROUPS.map((group) => {
        const rows = records.filter((r) => r.group === group);
        if (rows.length === 0 && !forceGroups.includes(group)) return null;
        return (
          <div
            key={group}
            id={`dns-group-${group}`}
            className={highlightGroup === group ? "ms-attention" : undefined}
            style={{ maxWidth: 1000 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                margin: "0 0 8px",
              }}
            >
              <p className="ms-microlabel" style={{ margin: 0 }}>
                {t(`detail.groups.${group}`)}
              </p>
              {groupExtras[group] ?? null}
            </div>
            {rows.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.55 }}>
                {emptyNotes[group]}
              </p>
            ) : (
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
                        <CopyChip
                          value={record.value}
                          {...(record.group === "verification"
                            ? { display: abbreviateDkim(record.value) }
                            : {})}
                        />
                      </td>
                      <td>{t("detail.ttlAuto")}</td>
                      <td>{record.priority ?? "—"}</td>
                      {showStatus ? (
                        <td style={{ whiteSpace: "nowrap" }}>
                          <RecordStatusBadge
                            status={combineRecordStatus({
                              live: record.live,
                              sesGate: sesGateFromRecordStatus(record.status),
                            })}
                            note={
                              record.inherited
                                ? t.rich("detail.inheritedDmarc", {
                                    ...codeRichTags,
                                    from: record.inherited.name,
                                    policy: record.inherited.policy,
                                  })
                                : record.live === "mismatch" && record.found
                                  ? t("detail.mismatchFound", {
                                      found: record.found
                                        .split("\n")
                                        .map(abbreviateDkim)
                                        .join("\n"),
                                    })
                                  : undefined
                            }
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </RecordsTable>
            )}
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
