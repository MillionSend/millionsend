"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { regionFlag } from "@/app/(dashboard)/domains/regions";
import { DotParts } from "@/components/dot-parts";
import { KvRow } from "@/components/kv-row";
import { PopoverMenu } from "@/components/popover-menu";
import { Sparkline } from "@/components/sparkline";
import { toast } from "@/components/toast";
import { formatDurationShort, formatRelative, formatUsd, withinLastDay } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import { useRegionFormats } from "./regions/formatters";
import {
  PauseDialog,
  QuotaDialog,
  ResumeDialog,
  StopDialog,
  TemplateDialog,
} from "./regions/region-dialogs";

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** One served region as console.regions.list returns it. */
export type ServedRegion = RouterOutputs["console"]["regions"]["list"]["served"][number];
type RegionList = RouterOutputs["console"]["regions"]["list"];

type RegionDialog = "quota" | "template" | "pause" | "resume" | "stop" | null;

/** The Serving / Sandbox / Unreachable pill. */
export function RegionBadge({ status }: { status: ServedRegion["status"] }) {
  const t = useTranslations("console.region");
  const tone = status === "serving" ? "success" : status === "sandbox" ? "warn" : "danger";
  return <span className={`ms-badge ms-badge-${tone}`}>{t(status)}</span>;
}

/**
 * The "…" menu of a served region (refresh probe, request quota increase,
 * production access template, pause/resume broadcasts in this region, stop
 * serving) with its dialogs. Rendered in the Overview's region cards
 * (boxed) and the Regions table rows (bare). `onChanged` re-fetches the
 * caller's list after an action.
 */
export function RegionMenu({
  region,
  onChanged,
  boxed = true,
}: {
  region: ServedRegion;
  onChanged: () => void;
  boxed?: boolean;
}) {
  const t = useTranslations("console.region");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const [dialog, setDialog] = useState<RegionDialog>(null);
  const close = () => setDialog(null);
  const refresh = useMutation(
    trpc.console.regions.refresh.mutationOptions({
      onSuccess: (results) => {
        const probe = results.find((r) => r.region === region.region);
        if (probe?.ok)
          toast(t("toast.probed", { region: region.region, ms: probe.latencyMs ?? 0 }));
        else
          toast(
            t("toast.probeFailed", { region: region.region, message: probe?.message ?? "" }),
            "danger",
          );
        onChanged();
      },
      onError: (error) =>
        toast(t("toast.probeFailed", { region: region.region, message: error.message }), "danger"),
    }),
  );
  const held = region.breaker !== null;
  const blocked = region.domainsVerified > 0;
  return (
    <>
      <PopoverMenu
        ariaLabel={common("actions")}
        boxed={boxed}
        items={[
          {
            label: t("menu.refresh"),
            busy: refresh.isPending,
            keepOpen: true,
            onSelect: () => refresh.mutate({ region: region.region }),
          },
          { label: t("menu.quota"), onSelect: () => setDialog("quota") },
          { label: t("menu.template"), onSelect: () => setDialog("template") },
          null,
          {
            label: t(held ? "menu.resume" : "menu.pause"),
            disabled: !(region.status === "serving" || held),
            onSelect: () => setDialog(held ? "resume" : "pause"),
          },
          {
            label: t("menu.stop"),
            danger: true,
            disabled: blocked,
            ...(blocked ? { trailing: t("menu.stopHint", { count: region.domainsVerified }) } : {}),
            onSelect: () => setDialog("stop"),
          },
        ]}
      />
      {dialog === "quota" ? <QuotaDialog region={region} open onClose={close} /> : null}
      {dialog === "template" ? (
        <TemplateDialog region={region.region} open onClose={close} />
      ) : null}
      {dialog === "pause" ? (
        <PauseDialog region={region.region} open onClose={close} onChanged={onChanged} />
      ) : null}
      {dialog === "resume" ? (
        <ResumeDialog region={region.region} open onClose={close} onChanged={onChanged} />
      ) : null}
      {dialog === "stop" ? <StopDialog region={region.region} open onClose={close} /> : null}
    </>
  );
}

/**
 * The 6px quota track; warn fill for a sandbox region. `segments` stack
 * fills left to right (broadcasts, then transactional) in place of the one
 * fill, and `tick` marks a fraction of the track (the broadcast share).
 */
export function QuotaBar({
  used,
  max,
  warn,
  segments,
  tick,
  style,
}: {
  used: number;
  max: number;
  warn: boolean;
  segments?: { value: number; color: string }[] | undefined;
  tick?: number | undefined;
  style?: React.CSSProperties;
}) {
  const pctOf = (value: number) => (max > 0 ? (value / max) * 100 : 0);
  const fills = segments ?? [{ value: used, color: warn ? "var(--ms-warn)" : "var(--ms-steel)" }];
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        display: "flex",
        height: 6,
        borderRadius: 999,
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        overflow: "hidden",
        ...style,
      }}
    >
      {fills.map((fill, i) => {
        const pct = pctOf(fill.value);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, position is identity
            key={i}
            style={{
              height: "100%",
              width: `${Math.min(100, Math.max(pct, pct > 0 ? 1.5 : 0))}%`,
              // Only the leading edge is rounded when segments stack; the
              // track's overflow rounds the far end.
              borderRadius: i === 0 ? (fills.length > 1 ? "999px 0 0 999px" : 999) : 0,
              background: fill.color,
              flex: "none",
            }}
          />
        );
      })}
      {tick !== undefined && tick > 0 && tick < 1 ? (
        <span
          style={{
            position: "absolute",
            left: `${tick * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: "var(--ms-bone)",
            opacity: 0.8,
          }}
        />
      ) : null}
    </div>
  );
}

type DotTone = "success" | "warn" | "danger" | "info" | "steel";

function Dot({ tone }: { tone: DotTone }) {
  return <span className="ms-dot" style={{ background: `var(--ms-${tone})`, marginRight: 6 }} />;
}

/**
 * The Overview's region card (flag, city, code, Serving/Sandbox badge, 24h
 * quota bar, key/value rows, the bleed sparkline of sends per hour, the
 * RegionMenu). The Events row reads the list-wide pipeline facts from the
 * regions.list query the caller already holds (react-query dedupes it).
 */
export function RegionCard({ region, onChanged }: { region: ServedRegion; onChanged: () => void }) {
  const t = useTranslations("console.region");
  const domains = useTranslations("domains");
  const trpc = useTRPC();
  const f = useRegionFormats();
  const list = useQuery(trpc.console.regions.list.queryOptions());
  const account = region.account;
  const sandbox = region.status === "sandbox";
  const plan = account?.pricingPlan ?? null;
  const enforcement = account?.enforcementStatus ?? null;
  const breaker = region.breaker;
  const txParked = withinLastDay(region.txParkedAt);
  // The window split: what broadcasts hold, what transactional mail holds
  // (warn-coloured past the usable reserve), and the share as a tick. A
  // sandbox region keeps its plain warn fill.
  const split =
    account && !sandbox && region.share !== null && region.usableReserve !== null
      ? {
          segments: [
            { value: region.bulkSent24h, color: "var(--ms-steel)" },
            {
              value: region.txSent24h ?? 0,
              color:
                (region.txSent24h ?? 0) > region.usableReserve
                  ? "var(--ms-warn)"
                  : "var(--ms-info)",
            },
          ],
          tick: region.share / account.quota.max24h,
        }
      : null;
  // The SQS pipeline is one queue for every region: the list-wide health and lag apply to each card.
  const events = (pipeline: Pick<RegionList, "eventsHealth" | "eventsLagSeconds">) =>
    pipeline.eventsHealth === null
      ? t("eventsOff")
      : pipeline.eventsHealth.status === "unhealthy"
        ? t("eventsUnhealthy")
        : pipeline.eventsHealth.status === "idle" || pipeline.eventsLagSeconds === null
          ? t("eventsIdle")
          : t("eventsLag", { lag: formatDurationShort(pipeline.eventsLagSeconds * 1000) });

  // [label, value, status dot]
  const rows: [string, string, DotTone?][] = [
    [
      t("maxRate"),
      account
        ? t("rateValue", {
            rate: f.oneDecimal(account.quota.maxSendRate),
            bucket: f.oneDecimal(region.effectiveRate ?? 0),
          })
        : t("planUnknown"),
    ],
    [
      t("plan"),
      plan === "NONE"
        ? t("planNone")
        : plan === "ESSENTIALS"
          ? t("planEssentials")
          : plan
            ? t("planOther", { plan })
            : t("planUnknown"),
    ],
    [
      t("enforcement"),
      enforcement ? enforcement.toLowerCase() : t("planUnknown"),
      enforcement === "HEALTHY" ? "success" : "warn",
    ],
    [t("domains"), t("domainsValue", { count: region.domainsVerified })],
    [
      t("queue"),
      region.bulkParked > 0
        ? t("queueValue", {
            waiting: f.n(region.bulkParked),
            count: region.waitingBroadcasts,
            clears: region.lastFinishesAt ? f.clearsAbout(region.lastFinishesAt) : "—",
          })
        : t("queueEmpty"),
    ],
    txParked
      ? [t("txParked"), t("txParkedAt", { ago: formatRelative(txParked, f.locale) }), "danger"]
      : [t("txParked"), t("txParkedNone"), "success"],
    sandbox
      ? [t("productionRow"), t("productionPending"), "warn"]
      : breaker && breaker.manualReason !== null
        ? [t("breaker"), t("breakerManual"), "danger"]
        : breaker?.reason
          ? [
              t("breaker"),
              t("breakerOpen", {
                metric: t(`metric.${breaker.reason.metric}`),
                rate: f.pct2(breaker.reason.rate),
              }),
              "danger",
            ]
          : [
              t("breaker"),
              t("breakerRates", {
                closed: t("breakerClosed"),
                bounce: region.week ? f.pct2(region.week.hardBounceRate) : "—",
                complaint: region.week ? f.pct2(region.week.complaintRate) : "—",
              }),
              "success",
            ],
    [t("events"), list.data ? events(list.data) : "—"],
    [
      t("cost"),
      t("costValue", {
        amount: formatUsd(region.cost.cents, f.locale),
        sent: f.n(region.cost.sentThisMonth),
        rate: formatUsd(region.cost.centsPer1k, f.locale),
      }) + (region.cost.tenants ? t("costTenants") : ""),
    ],
  ];

  return (
    <div
      className="ms-card ms-card-bleed"
      style={{
        position: "relative",
        padding: 20,
        paddingBottom: 78,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden="true">
          {regionFlag(region.region)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {domains(`regions.${region.region}`)}{" "}
            <span className="ms-title-badges">
              <RegionBadge status={region.status} />
            </span>
          </div>
          <div className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
            <DotParts text={`${region.region} · ${t(sandbox ? "sandboxLower" : "production")}`} />
          </div>
        </div>
        <RegionMenu region={region} onChanged={onChanged} />
      </div>
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontSize: "var(--ms-fs-label)",
          }}
        >
          <span style={{ color: "var(--ms-muted)" }}>{t("quota")}</span>
          {account ? (
            <span className="ms-mono" style={{ fontSize: 12.5 }}>
              {t("quotaOf", {
                used: f.n(account.quota.sentLast24h),
                max: f.n(account.quota.max24h),
              })}
            </span>
          ) : (
            <span style={{ color: "var(--ms-danger)", fontSize: 12 }}>
              {t("error", { message: region.error ?? "" })}
            </span>
          )}
        </div>
        <QuotaBar
          used={account?.quota.sentLast24h ?? 0}
          max={account?.quota.max24h ?? 0}
          warn={sandbox}
          {...(split ? { segments: split.segments, tick: split.tick } : {})}
          style={{ marginTop: 6 }}
        />
        {split && region.share !== null && region.usableReserve !== null ? (
          // Each legend entry wraps whole; the reserve note is the one place
          // an entry may break, when it alone is wider than the card.
          <div
            style={{
              display: "flex",
              gap: "2px 14px",
              flexWrap: "wrap",
              marginTop: 8,
              fontSize: 11.5,
              color: "var(--ms-bone)",
            }}
          >
            <span className="ms-part">
              <Dot tone="steel" />
              {t("legendBroadcasts", { sent: f.n(region.bulkSent24h), share: f.n(region.share) })}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="ms-part">
                <Dot tone={split.segments[1]?.color === "var(--ms-warn)" ? "warn" : "info"} />
                {t("legendTransactional", { sent: f.n(region.txSent24h ?? 0) })}
              </span>{" "}
              <span className="ms-part" style={{ color: "var(--ms-muted)" }}>
                {t("legendUsable", { usable: f.n(region.usableReserve) })}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <dl className="ms-kv">
        {rows.map(([label, value, tone]) => (
          <KvRow key={label} label={label}>
            <DotParts lead={tone ? <Dot tone={tone} /> : null} text={value} />
          </KvRow>
        ))}
      </dl>
      <span
        className="ms-microlabel"
        style={{ position: "absolute", left: 20, bottom: 60, pointerEvents: "none" }}
      >
        {t("sparkLabel")}
      </span>
      <div className="ms-bleed" style={{ height: 56 }}>
        <Sparkline
          values={region.hourly.map((p) => p.sent)}
          labels={region.hourly.map((p) => f.hourLabel(p.t))}
          formatValue={(v) => f.n(Math.round(v))}
          height={56}
          min={0}
        />
      </div>
    </div>
  );
}

/** The dashed "Add a region" card; the Regions page opens its panel for `?add=<region>`. */
export function AddRegionCard({ region }: { region: string }) {
  const t = useTranslations("console.overview.addRegion");
  return (
    <div
      className="ms-card"
      style={{
        borderStyle: "dashed",
        boxShadow: "none",
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        textAlign: "center",
        color: "var(--ms-muted)",
        minHeight: 220,
        padding: 20,
      }}
    >
      <div style={{ fontSize: 18, letterSpacing: 4, filter: "grayscale(1)", opacity: 0.7 }}>
        🇮🇪 🇯🇵 🇩🇪
      </div>
      <div style={{ fontWeight: 600, color: "var(--ms-bone)" }}>{t("title")}</div>
      <div style={{ fontSize: 13, maxWidth: 230 }}>{t("body")}</div>
      <Link
        href={`/console/regions?add=${encodeURIComponent(region)}`}
        className="ms-btn ms-btn-secondary"
      >
        {t("cta", { region })}
      </Link>
    </div>
  );
}
