"use client";

import { useTranslations } from "next-intl";
import { CopyChip } from "@/components/copy-chip";
import { RecordStatusBadge } from "@/components/dns-records-table";
import type { RecordStatus } from "@/lib/dns-record-status";
import { zoneRelativeName } from "@/lib/zone";

/** The inset card a DNS setup step sits in, outside the full records table. */
export function InsetCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--ms-line)",
        borderRadius: "var(--ms-r-card)",
        background: "var(--ms-inset)",
        padding: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * One record to add, as a provider's form asks for it: what it is and where
 * it stands, then its fields with copy chips. The name is zone-relative, with
 * the full hostname on hover. Whatever follows it (a line, actions) comes as
 * children.
 */
export function DnsRecordCard({
  label,
  status,
  record,
  domain,
  children,
  style,
}: {
  label: string;
  status: RecordStatus;
  record: { type: string; name: string; value: string; priority?: number | undefined };
  domain: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const t = useTranslations("domains");
  const cell = { color: "var(--ms-muted)" } as const;
  return (
    <InsetCard {...(style ? { style } : {})}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <p className="ms-microlabel" style={{ margin: 0 }}>
          {label}
        </p>
        <RecordStatusBadge status={status} />
      </div>
      <div
        className="ms-mono"
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "8px 14px",
          alignItems: "center",
          fontSize: 13,
        }}
      >
        <span style={cell}>{t("detail.columns.type")}</span>
        <span>{record.type}</span>
        <span style={cell}>{t("detail.columns.name")}</span>
        <span style={{ minWidth: 0, overflow: "hidden" }}>
          <CopyChip value={zoneRelativeName(record.name, domain)} title={record.name} />
        </span>
        <span style={cell}>{t("detail.columns.value")}</span>
        <span style={{ minWidth: 0, overflow: "hidden" }}>
          <CopyChip value={record.value} />
        </span>
        {record.priority !== undefined ? (
          <>
            <span style={cell}>{t("detail.columns.priority")}</span>
            <span>{record.priority}</span>
          </>
        ) : null}
      </div>
      {children}
    </InsetCard>
  );
}
