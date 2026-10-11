"use client";

import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PopoverMenu } from "@/components/popover-menu";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
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
 * serving) with its dialogs, at the end of a region table's row.
 * `onChanged` re-fetches the caller's list after an action.
 */
export function RegionMenu({ region, onChanged }: { region: ServedRegion; onChanged: () => void }) {
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
