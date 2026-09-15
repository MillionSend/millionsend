"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AddRegionCard, RegionCard } from "@/components/console/region-actions";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { useTRPC } from "@/lib/trpc";
import { HealthCard, HealthPill } from "./health-card";
import { KpiCards } from "./kpi-cards";
import { SentPerDay } from "./sent-per-day";
import { StatTiles } from "./stat-tiles";

const CARD = "var(--ms-r-card)";

function Ghosts({ n, height }: { n: number; height: number }) {
  return Array.from({ length: n }, (_, i) => i).map((i) => (
    <Skeleton key={i} width="100%" height={height} radius={CARD} />
  ));
}

function OverviewSkeleton() {
  return (
    <>
      <div className="ms-grid ms-grid-4" style={{ marginBottom: 16 }}>
        <Ghosts n={4} height={190} />
      </div>
      <div className="ms-grid ms-grid-4" style={{ marginBottom: 16 }}>
        <Ghosts n={4} height={104} />
      </div>
      <div className="ms-grid ms-grid-21">
        <Ghosts n={2} height={340} />
      </div>
    </>
  );
}

export function OverviewView() {
  const t = useTranslations("console.overview");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const summary = useQuery(trpc.console.overview.summary.queryOptions());
  const regions = useQuery(trpc.console.regions.list.queryOptions());
  const s = summary.data;

  const proof = s
    ? t("proof", {
        host: s.host ?? common("none"),
        version: s.version,
        serving: s.regions.serving,
        sandbox: s.regions.sandbox,
      }) +
      (s.regions.unreachable > 0 ? t("proofUnreachable", { count: s.regions.unreachable }) : "")
    : undefined;

  return (
    <>
      <PageHeader
        title={t("title")}
        {...(proof ? { subtitle: proof } : {})}
        actions={s ? <HealthPill summary={s} /> : null}
      />
      {summary.isError ? (
        <div className="ms-card ms-state">
          <span className="ms-state-glyph" aria-hidden="true">
            !
          </span>
          <p className="ms-state-headline">{common("loadError")}</p>
          <div className="ms-state-actions">
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={() => summary.refetch()}
            >
              {common("retry")}
            </button>
          </div>
        </div>
      ) : !s ? (
        <OverviewSkeleton />
      ) : (
        <>
          <KpiCards />
          <StatTiles summary={s} />
          <div className="ms-grid ms-grid-3" style={{ marginBottom: 16 }}>
            {regions.data ? (
              <>
                {regions.data.served.map((r) => (
                  <RegionCard
                    key={r.region}
                    region={r}
                    onChanged={() => {
                      regions.refetch();
                      summary.refetch();
                    }}
                  />
                ))}
                <AddRegionCard region={regions.data.known[0]?.region ?? "eu-west-1"} />
              </>
            ) : regions.isError ? (
              <div className="ms-card ms-state" style={{ gridColumn: "1 / -1" }}>
                <p className="ms-state-headline">{common("loadError")}</p>
                <div className="ms-state-actions">
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    onClick={() => regions.refetch()}
                  >
                    {common("retry")}
                  </button>
                </div>
              </div>
            ) : (
              <Ghosts n={3} height={220} />
            )}
          </div>
          <div className="ms-grid ms-grid-21">
            <SentPerDay />
            <HealthCard summary={s} />
          </div>
        </>
      )}
    </>
  );
}
