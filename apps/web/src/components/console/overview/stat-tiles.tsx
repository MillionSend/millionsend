"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ChartDialog, type Period } from "@/components/console/chart-dialog";
import { durationUnit, formatPercent } from "@/lib/console-format";
import { ProbeChart, TeamsChart } from "./charts";
import type { Summary } from "./health-card";

function Tile({
  label,
  value,
  sub,
  title,
  children,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  /** The history dialog's title. */
  title: string;
  children: (period: Period) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ms-card"
        style={{
          display: "block",
          width: "100%",
          padding: "18px 22px",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          color: "inherit",
        }}
        onClick={() => setOpen(true)}
      >
        <div className="ms-microlabel">{label}</div>
        <div className="ms-digits" style={{ fontSize: 26, lineHeight: 1.2, marginTop: 4 }}>
          {value}
        </div>
        <div style={{ fontSize: 13, color: "var(--ms-muted)", marginTop: 2 }}>{sub}</div>
      </button>
      {open ? (
        <ChartDialog open onClose={() => setOpen(false)} title={title}>
          {children}
        </ChartDialog>
      ) : null}
    </>
  );
}

export function StatTiles({ summary }: { summary: Summary }) {
  const t = useTranslations("console.overview");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const fmt = new Intl.NumberFormat(locale);
  const count = (v: number) => fmt.format(v);
  const { teams, contacts, domains, queue } = summary;
  const oldest =
    queue.oldestSeconds === null
      ? common("none")
      : (() => {
          const { unit, n } = durationUnit(queue.oldestSeconds);
          return common(`duration.${unit}`, { n });
        })();
  return (
    <div className="ms-grid ms-grid-4" style={{ marginBottom: 16 }}>
      <Tile
        label={t("tiles.teams")}
        value={count(teams.total)}
        sub={t("tiles.teamsSub", {
          free: count(teams.free),
          paid: count(teams.paid),
          system: count(teams.system),
          new: count(teams.newThisWeek),
        })}
        title={t("charts.teams_total")}
      >
        {(period) => <TeamsChart period={period} label={t("tiles.teams")} />}
      </Tile>
      <Tile
        label={t("tiles.contacts")}
        value={contacts.total === null ? common("none") : count(contacts.total)}
        sub={
          contacts.total === null
            ? t("tiles.contactsPending")
            : contacts.unsubscribed !== null && contacts.total > 0
              ? t("tiles.contactsSub", {
                  teams: count(teams.total),
                  unsubscribed: formatPercent(contacts.unsubscribed / contacts.total, locale, 1),
                })
              : t("tiles.contactsSubPlain", { teams: count(teams.total) })
        }
        title={t("charts.contacts_total")}
      >
        {(period) => (
          <ProbeChart
            probe="contacts_total"
            period={period}
            label={t("tiles.contacts")}
            formatValue={count}
          />
        )}
      </Tile>
      <Tile
        label={t("tiles.domains")}
        value={
          <>
            {count(domains.verified)}
            <span style={{ color: "var(--ms-muted)", fontWeight: 500, fontSize: 16 }}>
              {" "}
              / {count(domains.total)}
            </span>
          </>
        }
        sub={t("tiles.domainsSub", {
          pending: count(domains.pending),
          failed: count(domains.failed),
        })}
        title={t("charts.domains_verified")}
      >
        {(period) => (
          <ProbeChart
            probe="domains_verified"
            period={period}
            label={t("tiles.domains")}
            formatValue={count}
          />
        )}
      </Tile>
      <Tile
        label={t("tiles.queue")}
        value={queue.waiting === null ? common("none") : count(queue.waiting)}
        sub={
          queue.waiting === null
            ? t("tiles.queuePending")
            : t("tiles.queueSub", {
                waiting: count(queue.waiting),
                held: queue.quotaHeld === null ? common("none") : count(queue.quotaHeld),
                oldest,
              })
        }
        title={t("charts.queue_waiting")}
      >
        {(period) => (
          <ProbeChart
            probe="queue_waiting"
            period={period}
            label={t("tiles.queue")}
            formatValue={count}
          />
        )}
      </Tile>
    </div>
  );
}
