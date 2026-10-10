"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { DOMAIN_REGIONS, regionFlag } from "@/app/(dashboard)/domains/regions";
import { KvRow } from "@/components/kv-row";
import { NoticeStrip } from "@/components/notice-strip";
import { PageHeader } from "@/components/page-header";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { SortableTh, type SortDir } from "@/components/sortable-th";
import { Sparkline } from "@/components/sparkline";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { formatFinishAbout, withinLastDay } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { QuotaBar, RegionBadge, RegionMenu, type ServedRegion } from "../region-actions";
import { AddRegionPanel } from "./add-region-panel";
import { useRegionFormats } from "./formatters";
import { QuotaDialog } from "./region-dialogs";
import { ReserveCard } from "./reserve-card";

const COLUMNS = [
  "region",
  "status",
  "plan",
  "quota",
  "domains",
  "sent24h",
  "bounce7d",
  "complaints7d",
  "breaker",
] as const;
type Column = (typeof COLUMNS)[number];
const RIGHT: readonly Column[] = ["domains", "sent24h", "bounce7d", "complaints7d"];
const STATUS_ORDER = { serving: 0, sandbox: 1, unreachable: 2 } as const;

const mutedDash = (
  <span className="ms-mono" style={{ color: "var(--ms-muted)" }}>
    —
  </span>
);
const cardTitle: React.CSSProperties = {
  margin: "0 0 4px",
  fontSize: "var(--ms-fs-section)",
  fontWeight: 600,
};
const cardSub: React.CSSProperties = { margin: 0, fontSize: 13, color: "var(--ms-muted)" };

function RegionLabel({ region, tip }: { region: string; tip: string }) {
  const domains = useTranslations("domains");
  return (
    <>
      {regionFlag(region)}{" "}
      <Tooltip inline text={tip}>
        {domains(`regions.${region}`)}
      </Tooltip>
    </>
  );
}

function SkeletonRows() {
  return (
    <tbody>
      {[0, 1, 2].map((i) => (
        <tr key={i}>
          <td>
            <Skeleton width={120} height={13} />
          </td>
          <td>
            <SkeletonBadge />
          </td>
          <td>
            <Skeleton width={70} />
          </td>
          <td>
            <Skeleton width={140} height={6} radius={999} />
          </td>
          {[0, 1, 2, 3].map((j) => (
            <td key={j} className="right">
              <Skeleton width={48} />
            </td>
          ))}
          <td>
            <Skeleton width={60} />
          </td>
          <td />
        </tr>
      ))}
    </tbody>
  );
}

export function RegionsView() {
  const t = useTranslations("console.regions");
  const tr = useTranslations("console.region");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const f = useRegionFormats();
  const list = useQuery(trpc.console.regions.list.queryOptions());
  const refetch = () => {
    list.refetch();
  };
  const refresh = useMutation(
    trpc.console.regions.refresh.mutationOptions({
      onSuccess: (results) => {
        toast(tr("toast.probedAll", { count: results.length }));
        refetch();
      },
      onError: (error) => toast(error.message, "danger"),
    }),
  );

  const [sort, setSort] = useState<{ column: Column; dir: SortDir }>({
    column: "region",
    dir: "asc",
  });
  const domains = useTranslations("domains");
  const served = useMemo(() => {
    const rows = list.data?.served ?? [];
    const keyOf = (r: ServedRegion): string | number | null => {
      switch (sort.column) {
        case "region":
          return domains(`regions.${r.region}`);
        case "status":
          return STATUS_ORDER[r.status];
        case "plan":
          return r.account?.pricingPlan ?? "";
        case "quota":
          return r.account && r.account.quota.max24h > 0
            ? r.account.quota.sentLast24h / r.account.quota.max24h
            : null;
        case "domains":
          return r.domainsVerified;
        case "sent24h":
          return r.sent24h;
        case "bounce7d":
          return r.week?.hardBounceRate ?? null;
        case "complaints7d":
          return r.week?.complaintRate ?? null;
        case "breaker":
          return r.breaker ? (r.breaker.manualReason !== null ? 2 : 1) : 0;
      }
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka === kb) return 0;
      if (ka === null) return 1;
      if (kb === null) return -1;
      return (typeof ka === "string" ? ka.localeCompare(String(kb)) : ka - Number(kb)) * sign;
    });
  }, [list.data, sort, domains]);
  // One scale for every region's sparkline, so a quiet region reads as quiet.
  const sharedPeak = Math.max(1, ...served.flatMap((r) => r.daily.map((p) => p.sent)));

  const [addParam] = useUrlState("add", "");
  const known = list.data?.known ?? [];
  const addRegion = oneOf(DOMAIN_REGIONS, addParam, "") || (known[0]?.region ?? "eu-west-1");

  const counts = {
    serving: served.filter((r) => r.status === "serving").length,
    sandbox: served.filter((r) => r.status === "sandbox").length,
    known: known.length,
  };
  // The plans sold outrun a region's broadcast share: the cue to raise the
  // quota, with the request prefilled from the week's peaks and the backlog.
  const committed = list.data?.committedPerDay ?? null;
  const oversold =
    committed === null
      ? null
      : (served.find((r) => r.share !== null && committed > r.share) ?? null);
  const [quotaFor, setQuotaFor] = useState<ServedRegion | null>(null);
  const prefillFor = (r: ServedRegion) => {
    const daysToClear = r.lastFinishesAt
      ? Math.max(1, Math.ceil((new Date(r.lastFinishesAt).getTime() - Date.now()) / 86_400_000))
      : 1;
    const perDay = r.txPeak7d + Math.max(r.bulkPeak7d, r.bulkParked / daysToClear);
    // Never a request for less than the region already has.
    const floor = (r.account?.quota.max24h ?? 0) + 10_000;
    return {
      desired: Math.max(Math.ceil((1.5 * perDay) / 10_000) * 10_000, floor),
      ...(r.bulkParked > 0 && r.lastFinishesAt
        ? {
            // Read by AWS staff outside the operator's zone: a full stamp.
            justification: t("sold.justification", {
              date: formatFinishAbout(r.lastFinishesAt, f.locale),
            }),
          }
        : {}),
    };
  };

  const header = (
    <thead>
      <tr>
        {COLUMNS.map((column) => (
          <SortableTh
            key={column}
            column={column}
            label={t(`columns.${column}`)}
            sort={sort.column}
            dir={sort.dir}
            defaultDir={column === "region" || column === "status" ? "asc" : "desc"}
            right={RIGHT.includes(column)}
            onSort={(c, dir) => setSort({ column: c as Column, dir })}
          />
        ))}
        <th />
      </tr>
    </thead>
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        {...(list.data ? { subtitle: t("proof", counts) } : {})}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={refresh.isPending || !list.data}
            onClick={() => refresh.mutate({})}
          >
            <BtnSpinner on={refresh.isPending} />
            {t("refresh")}
          </button>
        }
      />
      {list.isError ? (
        <div className="ms-card ms-state">
          <span className="ms-state-glyph" aria-hidden="true">
            !
          </span>
          <p className="ms-state-headline">{common("loadError")}</p>
          <p className="ms-state-body">{list.error.message}</p>
          <div className="ms-state-actions">
            <button type="button" className="ms-btn ms-btn-secondary" onClick={refetch}>
              {common("retry")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {oversold && oversold.share !== null && committed !== null ? (
            <NoticeStrip
              tone="warn"
              text={
                <>
                  {t.rich("sold.text", {
                    committed: f.n(committed),
                    share: f.n(oversold.share),
                    region: oversold.region,
                    nowrap: (chunks) => <span style={{ whiteSpace: "nowrap" }}>{chunks}</span>,
                  })}
                  {oversold.bulkParked > 0
                    ? t("sold.backlog", {
                        waiting: f.n(oversold.bulkParked),
                        clears: oversold.lastFinishesAt
                          ? f.clearsAbout(oversold.lastFinishesAt)
                          : "—",
                      })
                    : null}
                </>
              }
              action={t("sold.action")}
              onAction={() => setQuotaFor(oversold)}
            />
          ) : null}
          {quotaFor ? (
            <QuotaDialog
              region={quotaFor}
              open
              onClose={() => setQuotaFor(null)}
              prefill={prefillFor(quotaFor)}
            />
          ) : null}
          <div className="ms-card" style={{ padding: 0, marginBottom: 16 }}>
            <Table className="nowrap">
              {header}
              {list.data ? (
                <tbody>
                  {served.map((r) => {
                    const account = r.account;
                    const sandbox = r.status === "sandbox";
                    const plan = account?.pricingPlan ?? null;
                    return (
                      <tr key={r.region}>
                        <td>
                          <RegionLabel
                            region={r.region}
                            tip={`${r.region} · ${tr(sandbox ? "sandboxLower" : "production")}`}
                          />
                        </td>
                        <td>
                          <RegionBadge status={r.status} />
                        </td>
                        <td className="ms-mono">
                          {plan === "NONE" || plan === "ESSENTIALS"
                            ? t(`planCell.${plan}`)
                            : (plan ?? mutedDash)}
                        </td>
                        <td style={{ minWidth: 150 }}>
                          {account ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <QuotaBar
                                used={account.quota.sentLast24h}
                                max={account.quota.max24h}
                                warn={sandbox}
                                style={{ flex: 1 }}
                              />
                              <span className="ms-mono ms-digits" style={{ fontSize: 12 }}>
                                {r.status === "serving"
                                  ? f.pct0(
                                      account.quota.max24h > 0
                                        ? account.quota.sentLast24h / account.quota.max24h
                                        : 0,
                                    )
                                  : tr("quotaOf", {
                                      used: f.n(account.quota.sentLast24h),
                                      max: f.n(account.quota.max24h),
                                    })}
                              </span>
                            </div>
                          ) : (
                            <span style={{ color: "var(--ms-danger)", fontSize: 12 }}>
                              {tr("error", { message: r.error ?? "" })}
                            </span>
                          )}
                        </td>
                        <td className="right num">{f.n(r.domainsVerified)}</td>
                        <td className="right num">{f.n(r.sent24h)}</td>
                        <td className="right num">
                          {r.week ? f.pct2(r.week.hardBounceRate) : mutedDash}
                        </td>
                        <td className="right num">
                          {r.week ? f.pct3(r.week.complaintRate) : mutedDash}
                        </td>
                        <td>
                          {sandbox ? (
                            mutedDash
                          ) : (
                            <>
                              <span
                                className="ms-dot"
                                style={{
                                  background: r.breaker ? "var(--ms-danger)" : "var(--ms-success)",
                                  marginRight: 6,
                                }}
                              />
                              {r.breaker === null
                                ? tr("breakerClosed")
                                : r.breaker.manualReason !== null
                                  ? tr("breakerManual")
                                  : r.breaker.reason
                                    ? tr("breakerOpen", {
                                        metric: tr(`metric.${r.breaker.reason.metric}`),
                                        rate: f.pct2(r.breaker.reason.rate),
                                      })
                                    : tr("breakerManual")}
                              {withinLastDay(r.txParkedAt) ? (
                                <span style={{ marginLeft: 10 }}>
                                  <span
                                    className="ms-dot"
                                    style={{ background: "var(--ms-danger)", marginRight: 6 }}
                                  />
                                  {tr("txParkedChip")}
                                </span>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className="right" style={{ width: 40 }}>
                          <RegionMenu region={r} onChanged={refetch} boxed={false} />
                        </td>
                      </tr>
                    );
                  })}
                  {known.map((k) => (
                    <tr key={k.region}>
                      <td>
                        <RegionLabel region={k.region} tip={k.region} />
                      </td>
                      <td>
                        <span className="ms-badge ms-badge-neutral">{tr("notProvisioned")}</span>
                      </td>
                      <td>{mutedDash}</td>
                      <td>{mutedDash}</td>
                      {[0, 1, 2, 3].map((i) => (
                        <td key={i} className="right">
                          {mutedDash}
                        </td>
                      ))}
                      <td>{mutedDash}</td>
                      <td className="right" />
                    </tr>
                  ))}
                </tbody>
              ) : (
                <SkeletonRows />
              )}
            </Table>
          </div>
          <div className="ms-grid ms-grid-12">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {list.data ? (
                <ReserveCard list={list.data} onChanged={refetch} />
              ) : (
                <Skeleton width="100%" height={300} radius="var(--ms-r-card)" />
              )}
              <div className="ms-card" style={{ padding: 20, overflow: "hidden" }}>
                <div style={{ marginBottom: 16 }}>
                  <h3 style={cardTitle}>{t("sparks.title")}</h3>
                  <p style={cardSub}>{t("sparks.subtitle")}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {list.data
                    ? served.map((r) => (
                        <div key={r.region} style={{ margin: "0 -20px" }}>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              justifyContent: "space-between",
                              gap: "0 12px",
                              fontSize: "var(--ms-fs-label)",
                              padding: "0 20px 4px",
                            }}
                          >
                            <span>
                              <RegionLabel region={r.region} tip={r.region} />
                            </span>
                            <span
                              className="ms-mono ms-digits"
                              style={{
                                color: "var(--ms-muted)",
                                fontSize: 12,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {t("sparks.total", {
                                count: f.n(r.daily.reduce((sum, p) => sum + p.sent, 0)),
                              })}
                            </span>
                          </div>
                          <div style={{ height: 44 }}>
                            <Sparkline
                              values={r.daily.map((p) => p.sent)}
                              labels={r.daily.map((p) => f.dayLabel(p.t))}
                              formatValue={(v) => f.n(Math.round(v))}
                              height={44}
                              min={0}
                              max={sharedPeak}
                              color={r.status === "serving" ? "var(--ms-steel)" : "var(--ms-muted)"}
                            />
                          </div>
                        </div>
                      ))
                    : [0, 1].map((i) => (
                        <div key={i}>
                          <Skeleton width={140} height={13} />
                          <div style={{ marginTop: 8 }}>
                            <Skeleton width="100%" height={44} radius={6} />
                          </div>
                        </div>
                      ))}
                </div>
              </div>
              <div className="ms-card" style={{ padding: 20 }}>
                <div style={{ marginBottom: 16 }}>
                  <h3 style={cardTitle}>{t("perRegion.title")}</h3>
                  <p style={cardSub}>{t("perRegion.subtitle")}</p>
                </div>
                <dl className="ms-kv">
                  {(
                    [
                      "quota",
                      "sandbox",
                      "plan",
                      "configSet",
                      "topic",
                      "suppression",
                      "tenants",
                      "iam",
                      "postgres",
                    ] as const
                  ).map((row) => (
                    <KvRow key={row} label={t(`perRegion.rows.${row}`)}>
                      {t(`perRegion.rows.${row}Value`)}
                    </KvRow>
                  ))}
                </dl>
              </div>
            </div>
            {list.data ? (
              <AddRegionPanel
                region={addRegion}
                served={list.data.served.find((r) => r.region === addRegion)}
                envRegions={list.data.envRegions ?? [list.data.defaultRegion]}
              />
            ) : (
              <Skeleton width="100%" height={520} radius="var(--ms-r-card)" />
            )}
          </div>
        </>
      )}
    </>
  );
}
