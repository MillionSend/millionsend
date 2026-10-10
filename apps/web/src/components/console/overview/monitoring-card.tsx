"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ChartDialog } from "@/components/console/chart-dialog";
import { DotParts } from "@/components/dot-parts";
import { Skeleton } from "@/components/skeleton";
import { Tooltip } from "@/components/tooltip";
import { formatPercent } from "@/lib/console-format";
import { CONTENT_MONITORING_DOCS_URL } from "@/lib/docs-links";
import { useTRPC } from "@/lib/trpc";
import { LoadErrorCard } from "../safety/parts";
import { ProbeChart } from "./charts";

/**
 * The content monitor at a glance: the judge the env names, today's tallies,
 * the open monitor flags. Off, it says so and points at the guide; on, the
 * card opens the hourly sample history like the stat tiles do.
 */
export function MonitoringCard() {
  const t = useTranslations("console.overview.monitoring");
  const charts = useTranslations("console.overview.charts");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.monitor.status.queryOptions());
  const [open, setOpen] = useState(false);
  const nf = new Intl.NumberFormat(locale);
  const data = query.data;

  if (query.isError) return <LoadErrorCard onRetry={() => query.refetch()} />;
  if (!data) {
    return (
      <div className="ms-card" style={{ padding: 20, marginTop: 16 }}>
        <div style={{ display: "flex" }}>
          <Skeleton width={140} height={22} />
        </div>
        <div style={{ display: "flex", marginTop: 12 }}>
          <Skeleton width="60%" />
        </div>
      </div>
    );
  }

  const head = (
    <>
      <h3 className="ms-display" style={{ fontSize: 22, margin: 0, fontWeight: 500 }}>
        {t("title")}
      </h3>
      <p style={{ margin: "4px 0 12px", fontSize: 13, color: "var(--ms-muted)" }}>
        <DotParts text={data.judge.on ? t("subtitle") : t("off")} />
      </p>
    </>
  );

  if (!data.judge.on) {
    return (
      <div className="ms-card" style={{ padding: 20, marginTop: 16 }}>
        {head}
        <p style={{ margin: 0, fontSize: 13 }}>
          {t("offLead")}{" "}
          <a href={CONTENT_MONITORING_DOCS_URL} target="_blank" rel="noreferrer">
            {t("offDocs")}
          </a>
        </p>
      </div>
    );
  }

  const today = data.today;
  const unjudgedRate = today.sampled > 0 ? today.unjudged / today.sampled : null;
  const figures: { id: string; label: React.ReactNode; value: string; color?: string }[] = [
    { id: "judge", label: t("judge"), value: `${data.judge.provider} · ${data.judge.model}` },
    { id: "sampled", label: t("sampledToday"), value: nf.format(today.sampled) },
    { id: "judged", label: t("judged"), value: nf.format(today.judged) },
    {
      id: "unjudged",
      label: t("unjudgedRate"),
      value: unjudgedRate === null ? common("none") : formatPercent(unjudgedRate, locale, 1),
      ...(unjudgedRate !== null && unjudgedRate > 0.2 ? { color: "var(--ms-warn)" } : {}),
    },
    {
      id: "flagged",
      label: (
        <Tooltip inline text={t("flaggedTip", { score: data.flagScore })}>
          {t("flaggedToday")}
        </Tooltip>
      ),
      value: nf.format(today.flagged),
      ...(today.flagged > 0 ? { color: "var(--ms-warn)" } : {}),
    },
    {
      id: "flags",
      label: t("openFlags"),
      value: nf.format(data.openFlags),
      ...(data.openFlags > 0 ? { color: "var(--ms-danger)" } : {}),
    },
  ];
  return (
    <>
      <button
        type="button"
        className="ms-card"
        style={{
          display: "block",
          width: "100%",
          padding: 20,
          marginTop: 16,
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          color: "inherit",
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) return;
          setOpen(true);
        }}
      >
        {head}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 36px" }}>
          {figures.map((figure) => (
            <div key={figure.id}>
              <div className="ms-microlabel">{figure.label}</div>
              <div
                className={figure.id === "judge" ? "ms-mono" : "ms-digits"}
                style={{
                  fontSize: figure.id === "judge" ? 13 : 22,
                  marginTop: 4,
                  color: figure.color,
                }}
              >
                {figure.value}
              </div>
            </div>
          ))}
        </div>
      </button>
      {open ? (
        <ChartDialog open onClose={() => setOpen(false)} title={charts("monitor_samples_1h")}>
          {(period) => (
            <ProbeChart
              probe="monitor_samples_1h"
              period={period}
              label={t("sampledToday")}
              formatValue={(v) => nf.format(Math.round(v))}
            />
          )}
        </ChartDialog>
      ) : null}
    </>
  );
}
