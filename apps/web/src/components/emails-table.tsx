"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { EmailStatusIcon } from "@/components/email-status-icon";
import { LeadCell } from "@/components/lead-cell";
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
  const tc = useTranslations("common");
  const router = useRouter();
  const items = rows;
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: "35%" }}>{t("list.to")}</th>
          <th style={{ width: "14%" }}>{t("list.status")}</th>
          <th>{t("list.subject")}</th>
          <th className="right" style={{ width: "13%" }}>
            {t("list.when")}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => {
          // The tile names the status in the badge's own words.
          const status = row.held
            ? t("held.label")
            : row.broadcastId && row.latestStatus === "queued_quota"
              ? t("list.queuedBroadcast")
              : tc(`status.${row.latestStatus}`);
          return (
            <tr key={row.id} className="hoverable" onClick={() => router.push(`/emails/${row.id}`)}>
              <LeadCell
                tile={<EmailStatusIcon status={row.latestStatus} label={status} />}
                value={row.to[0] ?? row.subject}
                href={`/emails/${row.id}`}
                more={row.to.slice(1)}
                mono
              />
              <td>
                {row.held ? (
                  <Tooltip inline text={t("held.body")}>
                    <StatusBadge status={row.latestStatus} label={status} />
                  </Tooltip>
                ) : (
                  <StatusBadge status={row.latestStatus} label={status} />
                )}
              </td>
              <td className="ms-cell-fill">
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
                      minWidth: 0,
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
          );
        })}
      </tbody>
    </Table>
  );
}
