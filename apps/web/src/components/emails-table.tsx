"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmailStatusIcon } from "@/components/email-status-icon";
import { RelativeTime } from "@/components/relative-time";
import { type BadgeStatus, StatusBadge } from "@/components/status-badge";
import { Table } from "@/components/table";

export interface EmailRow {
  id: string;
  to: string[];
  subject: string;
  latestStatus: BadgeStatus;
  createdAt: Date | string;
}

/** The emails list rows: the Emails page and a broadcast's own sends share one table. */
export function EmailsTable({ rows }: { rows: EmailRow[] }) {
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
            {t("list.sent")}
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
              <StatusBadge status={row.latestStatus} />
            </td>
            <td>
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
            </td>
            <td className="right">
              <RelativeTime date={row.createdAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
