"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Switch } from "@/components/switch";
import { toast } from "@/components/toast";
import { CONTENT_MONITORING_DOCS_URL } from "@/lib/docs-links";
import { type MonitorSettingKind, validMonitorValue } from "@/lib/monitor-settings";
import { useTRPC } from "@/lib/trpc";
import { CardHead, LoadErrorCard } from "./parts";

/** The form's groups, in the order the operator reads them. */
const GROUPS = [
  { key: "launch", fields: ["firstSends", "firstHours", "rampSends", "rampRate", "rampDays"] },
  { key: "tiers", fields: ["probationRate", "establishedRate", "trustedRate"] },
  { key: "broadcasts", fields: ["broadcastCopies", "broadcastCopiesNew"] },
  { key: "escalation", fields: ["anomalyMultiplier", "teamDailyCap", "instanceDailyCap"] },
  {
    key: "thresholds",
    fields: ["flagRisk", "alertRisk", "pauseRisk", "autoPause", "flagScore"],
  },
] as const;

type Draft = string | boolean | null;

export function MonitorSettingsView() {
  const t = useTranslations("console.safety.monitor");
  const safety = useTranslations("console.safety");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.console.monitor.settings.get.queryOptions());
  // undefined = untouched; null = reset to default; a string is the typed value.
  const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>({});
  const save = useMutation(
    trpc.console.monitor.settings.update.mutationOptions({
      onSuccess: async () => {
        setDrafts({});
        toast(t("saved"));
        await queryClient.invalidateQueries({
          queryKey: trpc.console.monitor.settings.get.queryKey(),
        });
      },
      onError: (error) => {
        toast(
          error.message === "thresholds_order"
            ? t("order")
            : t("error", { message: error.message }),
          "danger",
        );
      },
    }),
  );

  if (query.isError) return <LoadErrorCard onRetry={() => query.refetch()} />;
  if (query.isPending) return <SettingsSkeleton />;
  const { judge, settings } = query.data;
  const byKey = new Map<string, (typeof settings)[number]>(settings.map((s) => [s.key, s]));

  /** The value the form would send for a key, or undefined when untouched. */
  const pending = (key: string): number | boolean | null | undefined => {
    const draft = drafts[key];
    if (draft === undefined) return undefined;
    if (draft === null || typeof draft === "boolean") return draft;
    return draft.trim() === "" ? null : Number(draft);
  };
  const invalid = new Set(
    settings
      .filter((s) => {
        const value = pending(s.key);
        return typeof value === "number" && !validMonitorValue(s.kind, value);
      })
      .map((s) => s.key),
  );
  const effective = (key: string): number | boolean => {
    const value = pending(key);
    const setting = byKey.get(key);
    if (!setting) return 0;
    if (value === undefined) return setting.value;
    return value === null ? setting.fallback : value;
  };
  const ordered =
    Number(effective("flagRisk")) < Number(effective("alertRisk")) &&
    Number(effective("alertRisk")) < Number(effective("pauseRisk"));
  const touched = Object.keys(drafts).filter((key) => drafts[key] !== undefined);
  const canSave = touched.length > 0 && invalid.size === 0 && ordered && !save.isPending;

  const submit = () => {
    if (!canSave) return;
    const changes: Record<string, number | boolean | null> = {};
    for (const key of touched) {
      const value = pending(key);
      if (value !== undefined) changes[key] = value;
    }
    save.mutate(changes as Parameters<typeof save.mutate>[0]);
  };

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/console/safety" label={t("crumb")} />
            <CrumbEnd label={t("title")} />
          </>
        }
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={!canSave}
            onClick={submit}
          >
            <BtnSpinner on={save.isPending} />
            {t("save")}
          </button>
        }
      />

      <div className="ms-card" style={{ padding: 20, marginBottom: 16 }}>
        <CardHead title={t("judge.title")} />
        {judge.on ? (
          <dl className="ms-kv" style={{ gridTemplateColumns: "max-content 1fr" }}>
            <dt>{t("judge.provider")}</dt>
            <dd style={{ textAlign: "left" }}>{judge.provider}</dd>
            <dt>{t("judge.model")}</dt>
            <dd style={{ textAlign: "left" }}>{judge.model}</dd>
            {judge.region ? (
              <>
                <dt>{t("judge.region")}</dt>
                <dd style={{ textAlign: "left" }}>{judge.region}</dd>
              </>
            ) : null}
            {judge.baseUrl ? (
              <>
                <dt>{t("judge.baseUrl")}</dt>
                <dd style={{ textAlign: "left", overflowWrap: "anywhere" }}>{judge.baseUrl}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p style={{ margin: 0, fontSize: 13 }}>{t("judge.off")}</p>
        )}
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          {t(judge.on ? "judge.change" : "judge.offLead")}{" "}
          <a href={CONTENT_MONITORING_DOCS_URL} target="_blank" rel="noreferrer">
            {t("judge.docs")}
          </a>
        </p>
        {judge.on ? null : (
          <pre className="ms-mono" style={{ margin: "10px 0 0", fontSize: 12 }}>
            {"ABUSE_JUDGE=typesafe\nABUSE_JUDGE_API_KEY=...\nABUSE_JUDGE_MODEL=jev-1.13.0"}
          </pre>
        )}
      </div>

      {GROUPS.map((group) => (
        <div key={group.key} className="ms-card" style={{ padding: 20, marginBottom: 16 }}>
          <CardHead title={t(`groups.${group.key}`)} subtitle={t(`groupsSub.${group.key}`)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 24px" }}>
            {group.fields.map((key) => {
              const setting = byKey.get(key);
              if (!setting) return null;
              return (
                <Field
                  key={key}
                  setting={setting}
                  draft={drafts[key]}
                  invalid={invalid.has(key)}
                  disabled={save.isPending}
                  onChange={(draft) => setDrafts((d) => ({ ...d, [key]: draft }))}
                  onReset={() =>
                    // Only a stored value can be cleared; an env or default value has nothing to reset.
                    setDrafts((d) => ({
                      ...d,
                      [key]: setting.source === "db" ? null : undefined,
                    }))
                  }
                />
              );
            })}
          </div>
          {group.key === "thresholds" && !ordered ? (
            <p className="ms-field-error" style={{ marginTop: 12 }}>
              {t("order")}
            </p>
          ) : null}
        </div>
      ))}
      <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>
        {safety("monitor.footnote")}
      </p>
    </>
  );
}

function Field({
  setting,
  draft,
  invalid,
  disabled,
  onChange,
  onReset,
}: {
  setting: {
    key: string;
    value: number | boolean;
    source: "db" | "env" | "default";
    default: number | boolean;
    /** What applies once the stored value is cleared: the env value, else the default. */
    fallback: number | boolean;
    kind: MonitorSettingKind;
  };
  draft: Draft | undefined;
  invalid: boolean;
  disabled: boolean;
  onChange: (draft: Draft) => void;
  onReset: () => void;
}) {
  const t = useTranslations("console.safety.monitor");
  const id = useId();
  const fallbackSource = setting.fallback === setting.default ? "default" : "env";
  const shownSource = draft === undefined ? setting.source : draft === null ? fallbackSource : "db";
  const resettable = draft === undefined ? setting.source === "db" : draft !== null;
  const meta = (
    <div style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--ms-muted)", marginTop: 6 }}>
      <span>{t(`source.${shownSource}`, { value: String(setting.fallback) })}</span>
      {resettable ? (
        <button
          type="button"
          className="ms-link"
          style={{ font: "inherit", padding: 0, background: "none", border: 0, cursor: "pointer" }}
          disabled={disabled}
          onClick={onReset}
        >
          {t("reset")}
        </button>
      ) : null}
    </div>
  );
  if (setting.kind === "bool") {
    const checked =
      draft === undefined || draft === null
        ? Boolean(draft === null ? setting.fallback : setting.value)
        : draft === true;
    return (
      <div className="ms-field" style={{ flex: "1 1 260px", maxWidth: 320 }}>
        <label htmlFor={id}>{t(`fields.${setting.key}`)}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Switch
            checked={checked}
            disabled={disabled}
            ariaLabel={t(`fields.${setting.key}`)}
            onChange={(next) => onChange(next)}
          />
          <span style={{ fontSize: 13 }}>{t(checked ? "on" : "off")}</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 4 }}>
          {t(`hints.${setting.key}`)}
        </div>
        {meta}
      </div>
    );
  }
  const shown =
    draft === undefined
      ? String(setting.value)
      : draft === null
        ? String(setting.fallback)
        : String(draft);
  return (
    <div className="ms-field" style={{ flex: "1 1 260px", maxWidth: 320 }}>
      <label htmlFor={id}>{t(`fields.${setting.key}`)}</label>
      <input
        id={id}
        type="number"
        className={invalid ? "ms-input ms-number error" : "ms-input ms-number"}
        style={{ width: "100%" }}
        step={setting.kind === "rate" ? "any" : 1}
        min={setting.kind === "multiplier" ? 1 : 0}
        max={setting.kind === "rate" ? 1 : setting.kind === "score" ? 100 : undefined}
        disabled={disabled}
        value={shown}
        onChange={(event) => onChange(event.target.value)}
      />
      <div style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 4 }}>
        {t(`hints.${setting.key}`)} · {t(`kinds.${setting.kind}`)}
      </div>
      {meta}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", marginBottom: 10 }}>
          <Skeleton width={160} height={13} />
        </div>
        <div style={{ display: "flex" }}>
          <Skeleton width={260} height={30} />
        </div>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="ms-card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", marginBottom: 16 }}>
            <Skeleton width={140} height={22} />
          </div>
          <div className="ms-wrap-row" style={{ display: "flex", gap: 24 }}>
            <Skeleton width={260} height={60} />
            <Skeleton width={260} height={60} />
          </div>
        </div>
      ))}
    </>
  );
}
