"use client";

import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { GradientBanner } from "@/components/gradient-banner";
import { PauseIcon } from "@/components/icons/warmup-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatBlock, StatStrip } from "@/components/stat-block";
import { StatusDot } from "@/components/status-badge";
import { StepRail } from "@/components/step-rail";
import { Switch } from "@/components/switch";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { PaceBand, warmupSentSteps, warmupTodayStep } from "@/components/warmup-rail";
import { formatPercent } from "@/lib/console-format";
import {
  formatDate,
  formatDay,
  formatDayTime,
  formatStepDay,
  formatStepTime,
  roundUpToQuarterHour,
} from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import {
  formatWarmupPercent,
  type Translate,
  utcDayInstant,
  type WarmupSignalView,
  warmupPlanSteps,
  warmupReasons,
} from "@/lib/warmup";
import type { AppRouter } from "@/server/routers";
import { ConfigSection, StatusRow } from "./parts";

type Warmup = inferRouterOutputs<AppRouter>["domains"]["warmup"];
type Settings = Partial<Warmup["settings"]>;
type Action = "on" | "pause" | "resume" | "off";

const POSTMASTER_URL = "https://postmaster.google.com/";

const RESULT_COLOR: Record<WarmupSignalView["result"], string> = {
  within: "var(--ms-success)",
  missed: "var(--ms-warn)",
  severe: "var(--ms-danger)",
  unknown: "var(--ms-faint)",
};

const linkStyle: React.CSSProperties = {
  color: "var(--ms-bone)",
  textDecoration: "underline",
  whiteSpace: "nowrap",
};

function useCopy() {
  const t = useTranslations("warmup");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  return { t, locale, n: (value: number) => nf.format(value) };
}

/** The warm-up's line in the status rows above the tabs; nothing while it is off. */
export function WarmupStatus({ data }: { data: Warmup }) {
  const { t, locale, n } = useCopy();
  if (data.status === "warming" && data.today) {
    return (
      <StatusRow
        text={t("row.warming", {
          perDay: n(data.today.allowance),
          day: String(data.sendingDays + 1),
        })}
        note={t("row.warmingNote")}
      />
    );
  }
  if (data.status === "done" && data.doneAt) {
    return (
      <StatusRow
        text={t("row.done", { perDay: n(data.volume), date: formatDay(data.doneAt, locale) })}
        note={t("row.doneNote")}
      />
    );
  }
  if (data.status !== "paused") return null;
  return (
    <GradientBanner variant="danger" icon={<PauseIcon />} title={t("row.pausedTitle")}>
      {[
        warmupReasons(data.pauseSignals ?? [], t, locale),
        data.waiting > 0
          ? t("row.pausedWaiting", { waiting: data.waiting })
          : t("row.pausedNothing"),
      ]
        .filter(Boolean)
        .join(" ")}
    </GradientBanner>
  );
}

/** The run's days that sent, before today, oldest first. */
function historySteps(data: Warmup, t: Translate, locale: string) {
  return warmupSentSteps(
    data.days
      .filter((d) => d.sent > 0 && d.day !== data.today?.day)
      .reverse()
      .map((d) => ({ day: d.day, count: d.sent, outcome: d.outcome, signals: d.signals })),
    t,
    locale,
  );
}

/** The side a flagged figure is judged on, to tint: Gmail's delays and opens, the reported complaints, else the worse side. */
function flaggedSide(s: WarmupSignalView): "gmail" | "other" | null {
  if (s.result !== "missed" && s.result !== "severe") return null;
  if (s.key === "delays" || s.key === "opens") return "gmail";
  if (s.key === "complaints") return "other";
  return (s.gmail ?? 0) >= (s.other ?? 0) ? "gmail" : "other";
}

function HealthTable({
  health,
  openTracking,
  topRule = true,
}: {
  health: NonNullable<Warmup["health"]>;
  openTracking: boolean;
  topRule?: boolean;
}) {
  const { t, locale, n } = useCopy();
  // Complaints are judged against 0.05%, so they need the second decimal.
  const figure = (key: WarmupSignalView["key"], value: number | null) =>
    value === null ? "—" : formatPercent(value, locale, key === "complaints" ? 2 : 1);
  return (
    <section style={{ paddingTop: 22, borderTop: topRule ? "1px solid var(--ms-line)" : 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          margin: "0 0 12px",
        }}
      >
        <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
          {t("health.label", {
            day: health.yesterday
              ? t("health.yesterday")
              : formatStepDay(utcDayInstant(health.day), locale),
          })}
        </div>
        {health.checkedAt ? (
          <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-muted)" }}>
            {t("health.meta", {
              sent: n(health.sent),
              time: formatDayTime(health.checkedAt, locale),
            })}
          </span>
        ) : null}
      </div>
      <Table className="baseline">
        <thead>
          <tr>
            <th style={{ width: "30%" }}>{t("health.columns.signal")}</th>
            <th style={{ width: "16%" }}>{t("health.columns.result")}</th>
            <th className="right">{t("health.columns.gmail")}</th>
            <th className="right">{t("health.columns.other")}</th>
            <th className="right">{t("health.columns.line")}</th>
          </tr>
        </thead>
        <tbody>
          {health.signals.map((s) => {
            const flagged = flaggedSide(s);
            const tone = (side: "gmail" | "other") =>
              flagged === side ? { color: RESULT_COLOR[s.result] } : undefined;
            return (
              <tr key={s.key}>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {t(`health.rows.${s.key}`)}
                    {s.key === "opens" || s.key === "mailboxFull" ? (
                      <Tooltip text={t(`health.tips.${s.key}`)} />
                    ) : null}
                  </span>
                </td>
                {s.key === "opens" && !openTracking ? (
                  <td colSpan={3} style={{ color: "var(--ms-muted)" }}>
                    {t("health.openTrackingOff")}
                  </td>
                ) : (
                  <>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                        <StatusDot color={RESULT_COLOR[s.result]} />
                        {t(`health.results.${s.result}`)}
                      </span>
                    </td>
                    <td className="right ms-mono" style={tone("gmail")}>
                      {s.key === "complaints" ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            color: "var(--ms-muted)",
                          }}
                        >
                          {t("health.notReported")}
                          <Tooltip text={t("health.tips.complaints")} />
                        </span>
                      ) : (
                        figure(s.key, s.gmail)
                      )}
                    </td>
                    <td className="right ms-mono" style={tone("other")}>
                      {figure(s.key, s.other)}
                    </td>
                  </>
                )}
                <td className="right ms-mono">{t(`health.lines.${s.key}`)}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
        {t.rich("health.footer", {
          link: (chunks) => (
            <a href={POSTMASTER_URL} target="_blank" rel="noreferrer" style={linkStyle}>
              {chunks}
            </a>
          ),
        })}
      </p>
    </section>
  );
}

function useSaveSettings(id: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.domains.updateWarmup.mutationOptions({
      // Returned, so the control stays busy until the new settings are on screen.
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.domains.warmup.queryKey({ id }) }),
    }),
  );
}

/** Daily target or starting volume: a whole number inside its limits, saved on Update. */
function VolumeSetting({
  id,
  field,
  data,
}: {
  id: string;
  field: "dailyTarget" | "startVolume";
  data: Warmup;
}) {
  const { t, n } = useCopy();
  const save = useSaveSettings(id);
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const current = data.settings[field];
  const limits = data.limits[field];
  const value = draft ?? String(current);
  const copy = field === "dailyTarget" ? "target" : "start";
  const disabled = !data.canManage || save.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = Number(value);
    const fits =
      Number.isInteger(next) &&
      next >= limits.min &&
      next <= limits.max &&
      (field === "dailyTarget"
        ? next >= data.settings.startVolume
        : next <= data.settings.dailyTarget);
    if (!fits) {
      setRefused(true);
      return;
    }
    save.mutate(
      { id, settings: field === "dailyTarget" ? { dailyTarget: next } : { startVolume: next } },
      {
        onSuccess: () => setDraft(null),
        onError: (error) =>
          trpcErrorCode(error) === "BAD_REQUEST" ? setRefused(true) : toast(t("error"), "danger"),
      },
    );
  }

  return (
    <ConfigSection title={t(`settings.${copy}Title`)} description={t(`settings.${copy}Hint`)}>
      <form
        onSubmit={submit}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          type="number"
          className={`ms-input mono${refused ? " error" : ""}`}
          style={{ width: 160 }}
          min={limits.min}
          max={limits.max}
          step={1}
          aria-label={t(`settings.${copy}Title`)}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setRefused(false);
          }}
        />
        <button
          type="submit"
          className="ms-btn ms-btn-secondary"
          disabled={disabled || draft === null || Number(draft) === current}
        >
          <BtnSpinner on={save.isPending} />
          {t("settings.update")}
        </button>
      </form>
      {refused ? (
        <p className="ms-field-error">
          {t(`settings.${copy}Error`, { min: n(limits.min), max: n(limits.max) })}
        </p>
      ) : null}
    </ConfigSection>
  );
}

/** Who goes first and what happens to inactive contacts, saved on change; then the volumes. */
function SettingsSections({
  id,
  data,
  showStart,
}: {
  id: string;
  data: Warmup;
  showStart: boolean;
}) {
  const { t, locale, n } = useCopy();
  const save = useSaveSettings(id);
  const [picking, setPicking] = useState(false);
  const s = data.settings;
  const disabled = !data.canManage || save.isPending;
  const update = (settings: Settings) =>
    save.mutate({ id, settings }, { onError: () => toast(t("error"), "danger") });
  const byProperty = s.orderProperty !== null || picking;
  // A stored key no contact carries any more still shows as chosen.
  const options =
    s.orderProperty && !data.properties.some((option) => option.key === s.orderProperty)
      ? [{ key: s.orderProperty, dated: 0, latest: null }, ...data.properties]
      : data.properties;
  // Every row is as tall as the property row's select, so the list keeps one gap.
  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 30,
    fontSize: 13.5,
    color: "var(--ms-bone)",
  };

  return (
    <>
      <ConfigSection title={t("settings.orderTitle")} description={t("settings.orderHint")}>
        <div style={{ display: "grid", gap: 4 }}>
          <label style={row}>
            <input
              type="checkbox"
              className="ms-checkbox"
              checked={s.orderByEngagement}
              disabled={disabled}
              onChange={(event) => update({ orderByEngagement: event.target.checked })}
            />
            {t("settings.byEngagement")}
          </label>
          <label style={row}>
            <input
              type="checkbox"
              className="ms-checkbox"
              checked={s.orderByTransactional}
              disabled={disabled}
              onChange={(event) => update({ orderByTransactional: event.target.checked })}
            />
            {t("settings.byTransactional")}
          </label>
          <div style={{ ...row, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="checkbox"
                className="ms-checkbox"
                checked={byProperty}
                disabled={disabled}
                onChange={(event) => {
                  setPicking(event.target.checked);
                  if (!event.target.checked && s.orderProperty) update({ orderProperty: null });
                }}
              />
              {t("settings.byProperty")}
            </label>
            <Select
              width={200}
              value={s.orderProperty ?? ""}
              ariaLabel={t("settings.byProperty")}
              disabled={disabled || !byProperty}
              onChange={(key) => update({ orderProperty: key })}
              options={[
                ...(s.orderProperty
                  ? []
                  : [{ value: "", label: t("settings.propertyPlaceholder"), disabled: true }]),
                ...options.map((option) => ({
                  value: option.key,
                  label: option.key,
                  hint: option.latest
                    ? t("settings.propertyDates", {
                        count: option.dated,
                        latest: formatDate(option.latest, locale),
                      })
                    : t("settings.propertyNoDates"),
                })),
              ]}
            />
            <span style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
              {s.orderProperty
                ? t("settings.propertyCoverage", {
                    count: n(data.audience.withProperty ?? 0),
                    total: n(data.audience.total),
                  })
                : t(options.length > 0 ? "settings.propertyHint" : "settings.propertyNone")}
            </span>
          </div>
        </div>
      </ConfigSection>

      <ConfigSection
        title={t("settings.inactiveTitle")}
        description={t("settings.inactiveHint", {
          inactive: data.audience.inactive,
          total: n(data.audience.total),
        })}
      >
        <Select
          width={280}
          value={s.skipInactive ? "skip" : "last"}
          ariaLabel={t("settings.inactiveTitle")}
          disabled={disabled}
          onChange={(value) => update({ skipInactive: value === "skip" })}
          options={[
            { value: "skip", label: t("settings.inactiveSkip") },
            { value: "last", label: t("settings.inactiveLast") },
          ]}
        />
      </ConfigSection>

      <VolumeSetting id={id} field="dailyTarget" data={data} />
      {showStart ? <VolumeSetting id={id} field="startVolume" data={data} /> : null}
    </>
  );
}

function OffView({
  id,
  data,
  busy,
  act,
}: {
  id: string;
  data: Warmup;
  busy: Action | null;
  act: (action: Action) => void;
}) {
  const { t, locale, n } = useCopy();
  const { audience, settings } = data;
  const preview = data.preview ?? [];
  const skip = settings.skipInactive;
  const note = [
    t(skip ? "off.previewActive" : "off.previewAll", {
      eligible: n(audience.total - (skip ? audience.inactive : 0)),
      days: preview.length,
    }),
    audience.inactive > 0
      ? t(skip ? "off.previewSkipped" : "off.previewLast", { inactive: audience.inactive })
      : "",
    t("off.previewTail"),
  ]
    .filter(Boolean)
    .join(" ");
  const label = t("off.preview", { total: n(audience.total) });
  return (
    <>
      <StatusRow text={t("off.row", { count: n(data.bestDay) })} note={t("off.rowNote")} />
      {preview.length > 0 ? (
        <PaceBand label={label} note={note} style={{ marginTop: 24 }}>
          <StepRail
            label={label}
            steps={warmupPlanSteps({
              perDay: preview,
              locale,
              t,
              labels: "days",
              startsNow: true,
              last: (count) => t("rail.lastAll", { count }),
            })}
          />
        </PaceBand>
      ) : null}
      <div className="ms-config-panel" style={{ marginTop: preview.length > 0 ? 12 : 24 }}>
        <ConfigSection title={t("off.switch")} description={t("off.switchHint")}>
          <Switch
            checked={busy === "on"}
            disabled={!data.canManage || busy !== null}
            onChange={() => act("on")}
            ariaLabel={t("off.switch")}
          />
        </ConfigSection>
        <SettingsSections id={id} data={data} showStart />
      </div>
    </>
  );
}

function WarmingView({
  id,
  data,
  busy,
  act,
  askOff,
}: {
  id: string;
  data: Warmup;
  busy: Action | null;
  act: (action: Action) => void;
  askOff: () => void;
}) {
  const { t, locale, n } = useCopy();
  const today = data.today;
  if (!today) return null;
  const slot = data.todayWindow;
  const allowance = n(today.allowance);
  const day = data.sendingDays + 1;
  const lastDay = data.projection.at(-1)?.day ?? today.day;
  const sent = data.days.reduce((total, d) => total + d.sent, 0);
  const ahead = warmupPlanSteps({
    perDay: [
      { day: today.day, count: today.allowance },
      ...data.projection.map((p) => ({ day: p.day, count: p.volume })),
    ],
    locale,
    t,
    labels: "dates",
    last: (count) => t("rail.target", { target: count }),
  }).slice(1);
  const steps = [
    ...historySteps(data, t, locale),
    warmupTodayStep({ ...today, window: slot }, t, locale),
    ...ahead,
  ];
  return (
    <>
      <StatStrip>
        <StatBlock
          label={t("stats.today")}
          value={n(today.sent)}
          hint={
            !today.checked
              ? t("stats.todaySubWaiting", { allowance })
              : slot
                ? t("stats.todaySub", {
                    allowance,
                    time: formatStepTime(roundUpToQuarterHour(slot.endsAt), locale),
                  })
                : t("stats.todaySubPlain", { allowance })
          }
        />
        <StatBlock
          label={t("stats.day")}
          value={String(day)}
          hint={t("stats.daySub", { total: String(day + data.projection.length) })}
        />
        <StatBlock
          label={t("stats.sent")}
          value={n(sent)}
          hint={
            data.startedAt
              ? t("stats.sentSub", { date: formatStepDay(data.startedAt, locale) })
              : undefined
          }
        />
        <StatBlock
          label={t("stats.target")}
          value={n(data.settings.dailyTarget)}
          hint={t("stats.targetSub", { date: formatStepDay(utcDayInstant(lastDay), locale) })}
        />
      </StatStrip>
      <PaceBand label={t("pace.label")} note={t("pace.note")} style={{ borderTop: 0 }}>
        <StepRail label={t("pace.label")} steps={steps} />
      </PaceBand>
      {data.health ? <HealthTable health={data.health} openTracking={data.openTracking} /> : null}
      <div className="ms-config-panel" style={{ marginTop: 34 }}>
        <SettingsSections
          id={id}
          data={data}
          showStart={data.sendingDays === 0 && today.sent === 0}
        />
        <ConfigSection title={t("settings.controlTitle")} description={t("settings.controlHint")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={!data.canManage || busy !== null}
              onClick={() => act("pause")}
            >
              <BtnSpinner on={busy === "pause"} />
              {t("settings.pause")}
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-destructive"
              disabled={!data.canManage || busy !== null}
              onClick={askOff}
            >
              {t("settings.turnOff")}
            </button>
          </div>
        </ConfigSection>
      </div>
    </>
  );
}

function PausedView({
  data,
  busy,
  act,
  askOff,
}: {
  data: Warmup;
  busy: Action | null;
  act: (action: Action) => void;
  askOff: () => void;
}) {
  const { t, locale, n } = useCopy();
  const { audience } = data;
  const sent = data.days.reduce((total, d) => total + d.sent, 0);
  const full = data.health?.signals.find((s) => s.key === "mailboxFull");
  const volume = n(data.resumeVolume);
  const items = [
    audience.inactive > 0 && {
      key: "who",
      title: t("paused.who"),
      body: t("paused.whoBody", {
        pct: formatWarmupPercent(audience.inactive / Math.max(1, audience.total), locale),
      }),
      link: (
        <Link href="/audience" style={linkStyle}>
          {t("paused.whoLink")}
        </Link>
      ),
    },
    {
      key: "spam",
      title: t("paused.spam"),
      body: t("paused.spamBody"),
      link: (
        <a href={POSTMASTER_URL} target="_blank" rel="noreferrer" style={linkStyle}>
          {t("paused.spamLink")}
        </a>
      ),
    },
    ((full?.gmail ?? 0) > 0 || (full?.other ?? 0) > 0) && {
      key: "dead",
      title: t("paused.dead"),
      body: t("paused.deadBody"),
      link: null,
    },
  ].filter((item) => item !== false);
  return (
    <>
      <StatStrip>
        <StatBlock
          label={t("stats.waiting")}
          value={n(data.waiting)}
          hint={t("stats.waitingSub")}
        />
        <StatBlock
          label={t("stats.sent")}
          value={n(sent)}
          hint={
            data.startedAt
              ? t("stats.sentSub", { date: formatStepDay(data.startedAt, locale) })
              : undefined
          }
        />
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("stats.paused")}
          </div>
          <div style={{ fontSize: 15, color: "var(--ms-bone)", marginTop: 14 }}>
            {data.pausedAt ? formatStepDay(data.pausedAt, locale) : null}
          </div>
          {/* Paused before its first check, it has no day behind it to name. */}
          {data.sendingDays > 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 4 }}>
              {t("stats.pausedSub", { day: String(data.sendingDays) })}
            </div>
          ) : null}
        </div>
        <StatBlock label={t("stats.target")} value={n(data.settings.dailyTarget)} />
      </StatStrip>
      {data.health ? (
        <HealthTable health={data.health} openTracking={data.openTracking} topRule={false} />
      ) : data.pausedAt ? (
        <p style={{ margin: "22px 0 0", fontSize: 13.5, color: "var(--ms-muted)" }}>
          {t("health.pausedByTeam", { date: formatStepDay(data.pausedAt, locale) })}
        </p>
      ) : null}
      <div className="ms-config-panel" style={{ marginTop: 34 }}>
        <ConfigSection title={t("paused.beforeTitle")} description={t("paused.beforeHint")}>
          <ol
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "grid",
              gap: 12,
              maxWidth: 760,
            }}
          >
            {items.map((item, i) => (
              <li
                key={item.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "28px 1fr",
                  gap: 4,
                  fontSize: 13.5,
                  lineHeight: 1.5,
                }}
              >
                <span
                  className="ms-mono"
                  style={{ color: "var(--ms-muted)", fontSize: 12, paddingTop: 2 }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ color: "var(--ms-bone)" }}>
                  {item.title}
                  <span style={{ display: "block", color: "var(--ms-muted)", fontSize: 12.5 }}>
                    {item.body} {item.link}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </ConfigSection>
        <ConfigSection
          title={t("paused.resumeTitle")}
          description={
            data.waitingExpiresAt
              ? t("paused.resumeHint", {
                  volume,
                  date: formatStepDay(data.waitingExpiresAt, locale),
                })
              : t("paused.resumeHintPlain", { volume })
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={!data.canManage || busy !== null}
              onClick={() => act("resume")}
            >
              <BtnSpinner on={busy === "resume"} />
              {t("paused.resume", { volume })}
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-destructive"
              disabled={!data.canManage || busy !== null}
              onClick={askOff}
            >
              {t("settings.turnOff")}
            </button>
          </div>
        </ConfigSection>
      </div>
    </>
  );
}

function DoneView({
  data,
  busy,
  act,
}: {
  data: Warmup;
  busy: Action | null;
  act: (action: Action) => void;
}) {
  const { t, locale, n } = useCopy();
  return (
    <>
      {data.doneAt ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ms-bone)" }}>
          {t("done.line", { date: formatStepDay(data.doneAt, locale) })}
        </p>
      ) : null}
      <PaceBand
        label={t("pace.label")}
        note={t("done.note", { target: n(data.settings.dailyTarget) })}
        style={{ marginTop: 24 }}
      >
        <StepRail label={t("pace.label")} steps={historySteps(data, t, locale)} />
      </PaceBand>
      <button
        type="button"
        className="ms-btn ms-btn-secondary"
        disabled={!data.canManage || busy !== null}
        onClick={() => act("on")}
      >
        <BtnSpinner on={busy === "on"} />
        {t("done.again")}
      </button>
    </>
  );
}

/**
 * Mirrors the layout the tab loads into: while live, the stat strip over the
 * pace rail; while off or done, the status line over the rail.
 */
export function WarmupTabSkeleton({ live }: { live: boolean }) {
  return (
    <div style={{ marginTop: 24, maxWidth: 1000 }}>
      {live ? (
        <StatStrip>
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <div className="ms-microlabel" style={{ fontSize: 10.5, display: "flex" }}>
                <Skeleton width={72} height="1lh" />
              </div>
              <div
                className="ms-digits"
                style={{ fontSize: "var(--ms-fs-kpi)", marginTop: 6, display: "flex" }}
              >
                <Skeleton width={64} height="1lh" />
              </div>
              <div style={{ fontSize: 12.5, marginTop: 4, display: "flex" }}>
                <Skeleton width={120} height="1lh" />
              </div>
            </div>
          ))}
        </StatStrip>
      ) : (
        <div
          style={{
            display: "flex",
            fontSize: 13.5,
            border: "1px solid var(--ms-line)",
            borderRadius: 12,
            padding: "11px 16px",
          }}
        >
          <Skeleton width={320} height="1lh" />
        </div>
      )}
      <div className="ms-pacing" style={live ? { borderTop: 0 } : { marginTop: 24 }}>
        <div className="ms-microlabel" style={{ fontSize: 10.5, display: "flex" }}>
          <Skeleton width={110} height="1lh" />
        </div>
        <StepRail
          label=""
          steps={[0, 1, 2, 3, 4].map((i) => ({
            key: i,
            when: <Skeleton width={84} height={12} />,
            what: (
              <span style={{ display: "flex" }}>
                <Skeleton width={i === 2 ? 240 : 180} height="1lh" />
              </span>
            ),
          }))}
        />
      </div>
    </div>
  );
}

export function WarmupTab({
  id,
  query,
  live,
}: {
  id: string;
  query: UseQueryResult<Warmup, unknown>;
  /** Warming or paused, as the domain's own read says, for the layout the skeleton draws. */
  live: boolean;
}) {
  const t = useTranslations("warmup");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const set = useMutation(
    trpc.domains.setWarmup.mutationOptions({
      // The domain's own read carries the status that keeps this one loading off the tab.
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.domains.warmup.queryKey({ id }) }),
          queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) }),
        ]),
      onError: () => toast(t("error"), "danger"),
    }),
  );
  const [confirmingOff, setConfirmingOff] = useState(false);
  const closeOff = () => setConfirmingOff(false);
  const busy = set.isPending ? (set.variables?.action ?? null) : null;
  const act = (action: Action) => set.mutate({ id, action });
  function confirmOff() {
    if (!set.isPending) set.mutate({ id, action: "off" }, { onSuccess: closeOff });
  }

  if (query.isError) {
    return (
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 24 }}>
        <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)" }}>{t("loadError")}</p>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={() => query.refetch()}>
          {common("loadError.retry")}
        </button>
      </div>
    );
  }
  const data = query.data;
  if (!data) return <WarmupTabSkeleton live={live} />;

  const views = {
    off: <OffView id={id} data={data} busy={busy} act={act} />,
    warming: (
      <WarmingView
        id={id}
        data={data}
        busy={busy}
        act={act}
        askOff={() => setConfirmingOff(true)}
      />
    ),
    paused: <PausedView data={data} busy={busy} act={act} askOff={() => setConfirmingOff(true)} />,
    done: <DoneView data={data} busy={busy} act={act} />,
  };

  return (
    <div style={{ marginTop: 24, maxWidth: 1000 }}>
      {views[data.status]}
      <Modal
        open={confirmingOff}
        onClose={closeOff}
        onConfirm={confirmOff}
        title={t("turnOff.title")}
      >
        <p
          style={{
            margin: "10px 0 14px",
            color: "var(--ms-muted)",
            fontSize: 13.5,
            lineHeight: 1.6,
          }}
        >
          {data.waiting > 0
            ? t("turnOff.bodyWaiting", { waiting: data.waiting, days: data.sendingDays })
            : t("turnOff.body")}
        </p>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeOff}>
            {t("turnOff.keep")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={set.isPending}
            onClick={confirmOff}
          >
            <BtnSpinner on={set.isPending} />
            {t("turnOff.confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
