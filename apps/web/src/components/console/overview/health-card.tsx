"use client";

import type { ProbeKey } from "@millionsend/core";
import type { inferRouterOutputs } from "@trpc/server";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ChartDialog } from "@/components/console/chart-dialog";
import { Tooltip } from "@/components/tooltip";
import { formatPercent } from "@/lib/console-format";
import { formatBytes, formatDurationShort, formatRelative } from "@/lib/format";
import type { AppRouter } from "@/server/routers";
import { ProbeChart, RATE_SCALE } from "./charts";

export type Summary = inferRouterOutputs<AppRouter>["console"]["overview"]["summary"];
type Probe = Summary["probes"][number];

/** A worker that has not probed for this long is treated as down. */
const STALE_MS = 3 * 60_000;

type Tone = "success" | "warn" | "danger" | "off";

const DOT: Record<Tone, React.CSSProperties> = {
  success: { background: "var(--ms-success)" },
  warn: { background: "var(--ms-warn)" },
  danger: { background: "var(--ms-danger)" },
  off: {},
};

/** The probes the Health card shows rows for; the stat tiles' probes are not health. */
const HEALTH_PROBES: ReadonlySet<string> = new Set([
  "pg_latency_ms",
  "pg_size_bytes",
  "worker_heartbeat",
  "boss_waiting",
  "boss_failed",
  "ses_events_lag_s",
  "webhook_success_rate",
  "webhook_tripped",
  "kms_wrap_ms",
  "stripe_last_event_s",
  "retention_purged",
]);

/** The header pill's verdict: failing and warning probes among those that have a sample. */
export function healthStatus(summary: Summary, now = Date.now()) {
  let failing = 0;
  let warnings = 0;
  let total = 0;
  for (const p of summary.probes) {
    if (p.takenAt === null || !HEALTH_PROBES.has(p.key)) continue;
    total += 1;
    const stale = p.key === "worker_heartbeat" && now - new Date(p.takenAt).getTime() > STALE_MS;
    if (p.ok === false || stale) {
      if (p.severity === "bad") failing += 1;
      else warnings += 1;
    }
  }
  return { failing, warnings, total };
}

export function HealthPill({ summary }: { summary: Summary }) {
  const t = useTranslations("console.overview.health");
  const { failing, warnings, total } = healthStatus(summary);
  const [tone, label]: [string, string] =
    total === 0
      ? ["neutral", t("noProbes")]
      : failing > 0
        ? ["danger", t("failing", { count: failing })]
        : warnings > 0
          ? ["warn", t("warnings", { count: warnings, total })]
          : ["success", t("allOk", { count: total })];
  return (
    <Tooltip inline text={t("pillTip")}>
      <button
        type="button"
        className={`ms-badge ms-badge-${tone}`}
        style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
        onClick={() =>
          document.getElementById("health")?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      >
        <span
          className="ms-dot"
          style={{ background: tone === "neutral" ? "var(--ms-faint)" : `var(--ms-${tone})` }}
        />
        {label}
      </button>
    </Tooltip>
  );
}

interface Row {
  probe: ProbeKey;
  tone: Tone;
  how: string;
  /** The reading is a placeholder ("no probe yet"), drawn quieter. */
  muted?: boolean;
  formatValue: (value: number) => string;
  scale?: number;
}

function toneOf(sample: Probe | undefined, ok: boolean): Tone {
  if (!sample) return "off";
  if (ok) return "success";
  return sample.severity === "bad" ? "danger" : "warn";
}

export function HealthCard({ summary }: { summary: Summary }) {
  const t = useTranslations("console.overview");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const fmt = new Intl.NumberFormat(locale);
  const count = (v: number) => fmt.format(Math.round(v));
  const [open, setOpen] = useState<Row | null>(null);

  const probes = new Map(summary.probes.map((p) => [p.key, p]));
  const sampled = (key: ProbeKey) => {
    const p = probes.get(key);
    return p && p.takenAt !== null ? p : undefined;
  };
  const none = common("none");
  const seconds = (v: number) => formatDurationShort(v * 1000);
  const ms = (v: number) => formatDurationShort(v);
  /** The generic reading: the formatted value, or "probe failed" when it failed without one. */
  const reading = (p: Probe | undefined, text: (value: number) => string) =>
    !p ? none : p.value === null ? (p.ok ? none : t("health.how.failed")) : text(p.value);

  const rows: Row[] = [];

  const pg = sampled("pg_latency_ms");
  const pgSize = sampled("pg_size_bytes");
  rows.push({
    probe: "pg_latency_ms",
    tone: toneOf(pg, pg?.ok === true),
    how: reading(pg, (v) =>
      t("health.how.pg", {
        latency: ms(v),
        size: pgSize?.value === null || pgSize === undefined ? none : formatBytes(pgSize.value),
      }),
    ),
    formatValue: ms,
  });

  const worker = sampled("worker_heartbeat");
  const workerStale =
    worker !== undefined && Date.now() - new Date(worker.takenAt as Date).getTime() > STALE_MS;
  rows.push({
    probe: "worker_heartbeat",
    tone: !worker ? "off" : workerStale ? "danger" : toneOf(worker, worker.ok === true),
    how: !worker
      ? t("health.noProbes")
      : t(workerStale ? "health.stale" : "health.how.worker", {
          ago: formatRelative(worker.takenAt as Date, locale),
        }),
    muted: !worker,
    formatValue: count,
  });

  const waiting = sampled("boss_waiting");
  const failed = sampled("boss_failed");
  rows.push({
    probe: "boss_waiting",
    tone: toneOf(waiting, waiting?.ok === true && failed?.ok !== false),
    how: waiting
      ? t("health.how.boss", {
          waiting: waiting.value === null ? none : count(waiting.value),
          failed: failed?.value === null || failed === undefined ? none : count(failed.value),
        })
      : none,
    formatValue: count,
  });

  const events = sampled("ses_events_lag_s");
  rows.push({
    probe: "ses_events_lag_s",
    tone: toneOf(events, events?.ok === true),
    how: !events
      ? t("health.how.eventsOff")
      : events.ok === false
        ? t("health.how.eventsUnhealthy")
        : events.value === null
          ? t("health.how.eventsIdle")
          : t("health.how.events", { lag: seconds(events.value) }),
    muted: !events,
    formatValue: seconds,
  });

  const rate = sampled("webhook_success_rate");
  const tripped = sampled("webhook_tripped");
  const trippedCount =
    tripped?.value === null || tripped === undefined ? none : count(tripped.value);
  rows.push({
    probe: "webhook_success_rate",
    tone: toneOf(rate, rate?.ok === true && tripped?.ok !== false),
    how: !rate
      ? none
      : rate.value === null
        ? t("health.how.webhooksNone", { tripped: trippedCount })
        : t("health.how.webhooks", {
            rate: formatPercent(rate.value, locale, 1),
            tripped: trippedCount,
          }),
    formatValue: (v) => formatPercent(v, locale, 1),
    scale: RATE_SCALE,
  });

  const kms = sampled("kms_wrap_ms");
  if (kms) {
    rows.push({
      probe: "kms_wrap_ms",
      tone: toneOf(kms, kms.ok === true),
      how: reading(kms, (v) => t("health.how.kms", { ms: ms(v) })),
      formatValue: ms,
    });
  }

  const stripe = sampled("stripe_last_event_s");
  if (stripe) {
    rows.push({
      probe: "stripe_last_event_s",
      tone: toneOf(stripe, stripe.ok === true),
      how:
        stripe.value === null
          ? t("health.how.stripeNever")
          : t("health.how.stripe", {
              ago: formatRelative(new Date(Date.now() - stripe.value * 1000), locale),
            }),
      formatValue: seconds,
    });
  }

  const retention = sampled("retention_purged");
  rows.push({
    probe: "retention_purged",
    tone: toneOf(retention, retention?.ok === true),
    how: retention
      ? reading(retention, (v) => t("health.how.retention", { count: count(v) }))
      : t("health.how.retentionNever"),
    muted: !retention,
    formatValue: count,
  });

  return (
    <div id="health" className="ms-card" style={{ padding: 24 }}>
      <h3 className="ms-display" style={{ fontSize: 22, margin: 0, fontWeight: 500 }}>
        {t("health.title")}
      </h3>
      <p style={{ margin: "4px 0 12px", fontSize: 13, color: "var(--ms-muted)" }}>
        {t("health.subtitle")}
      </p>
      <div>
        {rows.map((row) => (
          <button
            key={row.probe}
            type="button"
            className="ms-health-row"
            onClick={() => setOpen(row)}
          >
            <span className={row.tone === "off" ? "ms-dot ring" : "ms-dot"} style={DOT[row.tone]} />
            <span>{t(`health.rows.${row.probe}`)}</span>
            <span
              className="ms-mono"
              style={{
                marginLeft: "auto",
                fontSize: 12,
                color: row.muted ? "var(--ms-faint)" : "var(--ms-muted)",
                textAlign: "right",
              }}
            >
              {row.how}
            </span>
          </button>
        ))}
      </div>
      {open ? (
        <ChartDialog open onClose={() => setOpen(null)} title={t(`charts.${open.probe}`)}>
          {(period) => (
            <ProbeChart
              probe={open.probe}
              period={period}
              label={t(`health.rows.${open.probe}`)}
              formatValue={open.formatValue}
              {...(open.scale ? { scale: open.scale } : {})}
            />
          )}
        </ChartDialog>
      ) : null}
    </div>
  );
}
