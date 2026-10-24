"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { mutedDash, Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { formatUsd } from "@/lib/format";
import type { AppRouter } from "@/server/routers";
import { QuotaBar, RegionBadge, RegionMenu, type ServedRegion } from "../region-actions";
import { useRegionFormats } from "../regions/formatters";
import { BroadcastsCell, RegionLabel, StatusText } from "../regions/region-cells";

type RegionList = inferRouterOutputs<AppRouter>["console"]["regions"]["list"];

/** The 24h quota's bar and figure; the split, the usable reserve and the max rate are its tooltip. */
function QuotaCell({ region }: { region: ServedRegion }) {
  const t = useTranslations("console.overview.regions");
  const tr = useTranslations("console.region");
  const f = useRegionFormats();
  if (!region.account) return mutedDash;
  const { sentLast24h: used, max24h: max, maxSendRate } = region.account.quota;
  const serving = region.status === "serving";
  const usedOf = tr("quotaOf", { used: f.n(used), max: f.n(max) });
  const rate = f.oneDecimal(maxSendRate);
  const tx = region.txSent24h ?? 0;
  // What broadcasts hold, then what transactional mail holds (warn past the
  // usable reserve), with the broadcast share as a tick. A sandbox region
  // keeps its plain warn fill.
  const split =
    serving && region.share !== null && region.usableReserve !== null
      ? {
          share: region.share,
          usable: region.usableReserve,
          segments: [
            { value: region.bulkSent24h, color: "var(--ms-steel)" },
            { value: tx, color: tx > region.usableReserve ? "var(--ms-warn)" : "var(--ms-info)" },
          ],
          tick: region.share / max,
        }
      : null;
  const tip = split
    ? [
        usedOf,
        tr("legendBroadcasts", { sent: f.n(region.bulkSent24h), share: f.n(split.share) }),
        `${tr("legendTransactional", { sent: f.n(tx) })} ${tr("legendUsable", { usable: f.n(split.usable) })}`,
        t("maxRate", { rate }),
      ].join("\n")
    : t("quotaShort", { quota: usedOf, rate });
  return (
    <Tooltip inline text={tip} triggerClassName="ms-quota-cell">
      <QuotaBar
        used={used}
        max={max}
        warn={region.status === "sandbox"}
        segments={split?.segments}
        tick={split?.tick}
        style={{ flex: 1 }}
      />
      <span className="ms-mono ms-digits" style={{ fontSize: 12 }}>
        {serving ? f.pct0(max > 0 ? used / max : 0) : usedOf}
      </span>
    </Tooltip>
  );
}

/** What AWS says of the account in the region: healthy, under review, or its sending paused. */
function SesAccountCell({ region }: { region: ServedRegion }) {
  const t = useTranslations("console.overview.regions");
  const status = region.account?.enforcementStatus ?? null;
  if (status === null) return mutedDash;
  if (status === "HEALTHY") return <StatusText tone="success" text={t("accountHealthy")} />;
  if (status === "PROBATION") {
    return <StatusText tone="warn" text={t("accountProbation")} tip={t("accountProbationTip")} />;
  }
  if (status === "SHUTDOWN") {
    return <StatusText tone="danger" text={t("accountShutdown")} tip={t("accountShutdownTip")} />;
  }
  return <StatusText tone="warn" text={status.toLowerCase()} />;
}

function Row({
  region: r,
  lines,
  onChanged,
}: {
  region: ServedRegion;
  lines: RegionList["complaintLines"];
  onChanged: () => void;
}) {
  const t = useTranslations("console.overview.regions");
  const tr = useTranslations("console.region");
  const f = useRegionFormats();
  const ses = r.sesComplaintRate;
  const sesTone =
    ses === null ? null : ses >= lines.breaker ? "danger" : ses >= lines.sesReview ? "warn" : null;
  return (
    <tr>
      <td>
        <RegionLabel region={r.region} tip={r.region} />
      </td>
      <td>
        {r.error !== null ? (
          <Tooltip inline text={tr("error", { message: r.error })}>
            <RegionBadge status={r.status} />
          </Tooltip>
        ) : (
          <RegionBadge status={r.status} />
        )}
      </td>
      {/* 120px keeps a 7-digit queue and a 4-digit cost inside a 998px column. */}
      <td style={{ minWidth: 120 }}>
        <QuotaCell region={r} />
      </td>
      <td>
        <BroadcastsCell region={r} complaintLine={lines.breaker} />
      </td>
      <td>
        <SesAccountCell region={r} />
      </td>
      <td className="right num">
        {r.bulkParked > 0 ? (
          <Tooltip
            inline
            text={
              r.breaker
                ? t("queueHeld", { count: r.waitingBroadcasts })
                : t("queueClears", {
                    count: r.waitingBroadcasts,
                    clears: r.lastFinishesAt ? f.clearsAbout(r.lastFinishesAt) : "—",
                  })
            }
          >
            {f.n(r.bulkParked)}
          </Tooltip>
        ) : (
          mutedDash
        )}
      </td>
      <td className="right num">{r.week ? f.pct2(r.week.hardBounceRate) : mutedDash}</td>
      <td className="right num">
        {ses === null ? (
          <Tooltip
            inline
            text={[
              t(r.sesComplaintRead ? "sesNone" : "sesUnreadable"),
              t("oursWatched", {
                ours: r.week ? f.pct3(r.week.complaintRate) : "—",
                limit: f.pctLimit(lines.breaker),
              }),
              tr("complaintEstimate"),
            ].join("\n")}
          >
            {mutedDash}
          </Tooltip>
        ) : (
          <Tooltip
            inline
            text={[
              t("sesRate"),
              t("sesLines", {
                review: f.pctLimit(lines.sesReview),
                pause: f.pctLimit(lines.sesPause),
              }),
              t("ourLines", {
                limit: f.pctLimit(lines.breaker),
                ours: r.week ? f.pct3(r.week.complaintRate) : "—",
              }),
              tr("complaintEstimate"),
            ].join("\n")}
          >
            <span style={sesTone ? { color: `var(--ms-${sesTone})` } : undefined}>
              {f.pct2(ses)}
            </span>
          </Tooltip>
        )}
      </td>
      <td className="right num">
        <Tooltip
          inline
          text={
            t("costTip", {
              sent: f.n(r.cost.sentThisMonth),
              rate: formatUsd(r.cost.centsPer1k, f.locale, 3),
            }) + (r.cost.tenants ? tr("costTenants") : "")
          }
        >
          {formatUsd(r.cost.cents, f.locale)}
        </Tooltip>
      </td>
      <td className="right ms-cell-menu" style={{ width: 40 }}>
        <RegionMenu region={r} onChanged={onChanged} />
      </td>
    </tr>
  );
}

/**
 * The Overview's served regions, one row each. Words and statuses sit left
 * and figures right, every cell on one text baseline; the reasons and the
 * details are tooltips.
 */
export function RegionsTable({ list, onChanged }: { list: RegionList; onChanged: () => void }) {
  const t = useTranslations("console.overview.regions.columns");
  return (
    <div className="ms-card ms-card-table" style={{ marginBottom: 16 }}>
      <Table className="nowrap baseline">
        <thead>
          <tr>
            <th>{t("region")}</th>
            <th>{t("status")}</th>
            <th>{t("quota")}</th>
            <th>{t("broadcasts")}</th>
            <th>{t("sesAccount")}</th>
            <th className="right">{t("queue")}</th>
            <th className="right">{t("bounce7d")}</th>
            <th className="right">{t("sesComplaints")}</th>
            <th className="right">{t("cost")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.served.map((r) => (
            <Row key={r.region} region={r} lines={list.complaintLines} onChanged={onChanged} />
          ))}
        </tbody>
      </Table>
    </div>
  );
}
