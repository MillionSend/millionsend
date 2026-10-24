"use client";

import type { NewDomainLimit } from "@millionsend/core";
import { limitSpent } from "@millionsend/core/limit-rules";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { EmailStatusIcon } from "@/components/email-status-icon";
import { LeadCell } from "@/components/lead-cell";
import { RelativeTime } from "@/components/relative-time";
import { type BadgeStatus, StatusBadge } from "@/components/status-badge";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { formatDateTime, formatDay, formatDayTime, formatTime } from "@/lib/format";
import { rowRelease } from "@/lib/new-domain-limit";

/** A hold the team may know the reason of; capacity and every silent hold read as a plain wait. */
export type WaitingFor = "domain_limit" | "warmup" | "warmup_paused" | "plan";

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
  domainId?: string | null;
  waitingFor?: WaitingFor | null;
  /** When the plan's limit renews, on a row it holds. */
  resumesAt?: Date | string | null;
  /** The earliest a row the new domain limit holds goes out, by its place in line. */
  sendsAfter?: Date | string | null;
}

/** One domain's day under the new domain limit, as the rows it holds read it. */
export type RowLimit = Pick<
  NewDomainLimit,
  "domainId" | "name" | "cap" | "used" | "pool" | "resetsAt"
>;

type Release = ReturnType<typeof rowRelease>;

/**
 * The "When" cell: the send time once the provider has it, otherwise what the
 * row is waiting for; the creation time always sits in the tooltip.
 */
function WhenCell({ row, release }: { row: EmailRow; release: Release | null }) {
  const t = useTranslations("emails");
  const locale = useLocale();
  if (row.sentAt) return <RelativeTime date={row.sentAt} />;
  const scheduled =
    row.latestStatus === "queued" && row.scheduledAt && new Date(row.scheduledAt) > new Date()
      ? new Date(row.scheduledAt)
      : null;
  const label = scheduled
    ? t("list.whenScheduled", { date: formatDayTime(scheduled, locale) })
    : release?.when === "next"
      ? t("list.whenAfter", { time: formatTime(release.at, locale) })
      : release?.when === "later"
        ? t("list.whenAfterDay", { date: formatDayTime(release.at, locale) })
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

/**
 * The emails list rows: the Emails page and a broadcast's own sends share one
 * table. `limits` are the team's domains under the new domain limit; a row it
 * holds names its domain from them, and reads as a plain wait once its
 * domain is no longer among them.
 */
export function EmailsTable({
  rows,
  broadcastChip = true,
  limits,
}: {
  rows: EmailRow[];
  /** Mark broadcast copies; off inside a broadcast, where every row is one. */
  broadcastChip?: boolean;
  limits?: readonly RowLimit[] | undefined;
}) {
  const t = useTranslations("emails");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const nf = new Intl.NumberFormat(locale);
  const tip = (
    row: EmailRow,
    waitingFor: WaitingFor | null,
    limit: RowLimit | undefined,
    release: Release | null,
  ) => {
    if (row.held) return t("held.body");
    if (waitingFor === "warmup") return t("list.waitingTip.warmup");
    if (waitingFor === "warmup_paused") return t("list.waitingTip.warmupPaused");
    if (waitingFor === "plan" && row.resumesAt) {
      return t("list.waitingTip.plan", { date: formatDayTime(row.resumesAt, locale) });
    }
    if (waitingFor !== "domain_limit" || !limit || !release) return null;
    if (release.when === "soon") return t("list.waitingTip.room", { domain: limit.name });
    const spent = limitSpent(limit);
    return [
      spent === "pool" && limit.pool
        ? t("list.waitingTip.spentPool", { cap: nf.format(limit.pool.cap) })
        : spent
          ? t("list.waitingTip.spentDomain", { domain: limit.name, cap: nf.format(limit.cap) })
          : null,
      t(`list.waitingTip.${release.when}`, {
        time: formatTime(release.at, locale),
        date: formatDay(release.at, locale),
      }),
    ]
      .filter(Boolean)
      .join(" ");
  };
  return (
    <Table>
      <thead>
        <tr>
          <th style={{ width: "33%" }}>{t("list.to")}</th>
          <th style={{ width: "18%" }}>{t("list.status")}</th>
          <th>{t("list.subject")}</th>
          <th className="right" style={{ width: "13%" }}>
            {t("list.when")}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const limit =
            row.waitingFor === "domain_limit"
              ? limits?.find((l) => l.domainId === row.domainId)
              : undefined;
          // A domain the limit let go of sends its held mail at the next drain.
          const waitingFor =
            row.waitingFor === "domain_limit" && limits && !limit ? null : (row.waitingFor ?? null);
          const release =
            waitingFor === "domain_limit" && limit ? rowRelease(row.sendsAfter, limit) : null;
          // The tile names the status in the badge's own words; a paused warm-up's pill is the warm-up's.
          const status = row.held
            ? t("held.label")
            : waitingFor
              ? t(`list.waitingFor.${waitingFor === "warmup_paused" ? "warmup" : waitingFor}`)
              : row.broadcastId && row.latestStatus === "queued_quota"
                ? t("list.queuedBroadcast")
                : tc(`status.${row.latestStatus}`);
          const badgeTip = tip(row, waitingFor, limit, release);
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
                {badgeTip ? (
                  <Tooltip inline text={badgeTip}>
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
                  <span style={{ minWidth: 0, maxWidth: 480 }}>
                    <Truncated text={row.subject} />
                  </span>
                </span>
              </td>
              <td className="right" style={{ whiteSpace: "nowrap" }}>
                <WhenCell row={row} release={release} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
