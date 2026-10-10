"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { EmailStatusIcon } from "@/components/email-status-icon";
import { RelativeTime } from "@/components/relative-time";
import { type BadgeStatus, StatusBadge } from "@/components/status-badge";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { formatDateTime, formatDayTime } from "@/lib/format";

export interface EmailRow {
  id: string;
  to: string[];
  subject: string;
  latestStatus: BadgeStatus;
  createdAt: Date | string;
  sentAt?: Date | string | null;
  scheduledAt?: Date | string | null;
  broadcastId?: string | null;
  /** A broadcast copy waiting out a hold on its region: shown as delayed. */
  held?: boolean;
}

/**
 * The "When" cell: the send time once the provider has it, otherwise what the
 * row is waiting for; the creation time always sits in the tooltip.
 */
function WhenCell({ row }: { row: EmailRow }) {
  const t = useTranslations("emails");
  const locale = useLocale();
  if (row.sentAt) return <RelativeTime date={row.sentAt} />;
  const scheduled =
    row.latestStatus === "queued" && row.scheduledAt && new Date(row.scheduledAt) > new Date()
      ? new Date(row.scheduledAt)
      : null;
  const label = scheduled
    ? t("list.whenScheduled", { date: formatDayTime(scheduled, locale) })
    : row.latestStatus === "queued_quota"
      ? t("list.whenWaiting")
      : row.latestStatus === "queued"
        ? t("list.whenQueued")
        : null;
  if (!label) return <RelativeTime date={row.createdAt} />;
  return (
    <Tooltip
      inline
      text={t("list.createdAt", { date: formatDateTime(new Date(row.createdAt), locale) })}
    >
      <span style={{ color: "var(--ms-muted)" }}>{label}</span>
    </Tooltip>
  );
}

/** The emails list rows: the Emails page and a broadcast's own sends share one table. */
export function EmailsTable({
  rows,
  broadcastChip = true,
}: {
  rows: EmailRow[];
  /** Mark broadcast copies; off inside a broadcast, where every row is one. */
  broadcastChip?: boolean;
}) {
  const t = useTranslations("emails");
  const router = useRouter();
  const items = rows;
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: "34%" }}>{t("list.to")}</th>
          <th style={{ width: "15%" }}>{t("list.status")}</th>
          <th>{t("list.subject")}</th>
          <th className="right" style={{ width: "13%" }}>
            {t("list.when")}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => (
          <tr key={row.id} className="hoverable" onClick={() => router.push(`/emails/${row.id}`)}>
            <td className="ms-mono">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                <EmailStatusIcon status={row.latestStatus} />
                <Link href={`/emails/${row.id}`} onClick={(event) => event.stopPropagation()}>
                  {row.to[0] ?? row.subject}
                </Link>
              </span>
              {row.to.length > 1 ? (
                <span style={{ color: "var(--ms-muted)", marginLeft: 8 }}>
                  +{row.to.length - 1}
                </span>
              ) : null}
            </td>
            <td>
              {row.held ? (
                <Tooltip inline text={t("held.body")}>
                  <StatusBadge status={row.latestStatus} label={t("held.label")} />
                </Tooltip>
              ) : (
                <StatusBadge
                  status={row.latestStatus}
                  label={
                    row.broadcastId && row.latestStatus === "queued_quota"
                      ? t("list.queuedBroadcast")
                      : undefined
                  }
                />
              )}
            </td>
            <td>
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {broadcastChip && row.broadcastId ? (
                  <span
                    className="ms-chip"
                    style={{ fontSize: 10.5, padding: "1px 7px", flex: "none" }}
                  >
                    {t("list.broadcastChip")}
                  </span>
                ) : null}
                <span
                  style={{
                    display: "block",
                    maxWidth: 480,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.subject}
                </span>
              </span>
            </td>
            <td className="right" style={{ whiteSpace: "nowrap" }}>
              <WhenCell row={row} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
