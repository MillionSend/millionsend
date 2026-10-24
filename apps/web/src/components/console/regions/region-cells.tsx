"use client";

import { useTranslations } from "next-intl";
import { regionFlag } from "@/app/(dashboard)/domains/regions";
import { mutedDash } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import type { ServedRegion } from "../region-actions";
import { useRegionFormats } from "./formatters";

/** The flag and the city, with `tip` (the AWS code) one hover away. */
export function RegionLabel({ region, tip }: { region: string; tip: string }) {
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

/**
 * A status cell's dot and words, the reason one hover away. The dot stays
 * outside the tooltip's trigger, so a column's dots line up and its words
 * start at one edge.
 */
export function StatusText({
  tone,
  text,
  tip,
}: {
  tone: "success" | "warn" | "danger";
  text: string;
  tip?: string | undefined;
}) {
  return (
    <>
      <span className="ms-dot" style={{ background: `var(--ms-${tone})`, marginRight: 8 }} />
      {tip ? (
        <Tooltip inline text={tip}>
          {text}
        </Tooltip>
      ) : (
        text
      )}
    </>
  );
}

/** Whether broadcasts flow in the region (the Overview's Broadcasts, the Regions page's breaker column). */
export function BroadcastsCell({
  region,
  complaintLine,
}: {
  region: ServedRegion;
  /** The breaker's complaint line: a complaint pause stored on another one counted all mail. */
  complaintLine: number;
}) {
  const t = useTranslations("console.overview.regions");
  const tr = useTranslations("console.region");
  const f = useRegionFormats();
  const breaker = region.breaker;
  if (!breaker) {
    return region.status === "serving" ? (
      <StatusText tone="success" text={t("broadcastsFlowing")} />
    ) : (
      mutedDash
    );
  }
  const reason = breaker.reason;
  const why =
    breaker.manualReason !== null || !reason
      ? t("pauseManual", { reason: breaker.manualReason ?? "" })
      : "windowHours" in reason
        ? t(
            reason.metric === "complaint" && reason.limit === complaintLine
              ? "pauseComplaints"
              : "pauseWindow",
            {
              metric: tr(`metric.${reason.metric}`),
              rate: f.pct2(reason.rate),
              hours: reason.windowHours,
              limit: f.pctLimit(reason.limit),
            },
          )
        : t("pauseSes", { rate: f.pct2(reason.rate), limit: f.pctLimit(reason.limit) });
  return (
    <StatusText
      tone="danger"
      text={t("broadcastsPaused")}
      tip={`${why}\n${t("pauseTransactional")}`}
    />
  );
}
