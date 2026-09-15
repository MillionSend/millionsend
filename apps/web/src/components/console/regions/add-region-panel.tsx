"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { regionFlag } from "@/app/(dashboard)/domains/regions";
import type { ServedRegion } from "../region-actions";
import { codeBlock, TemplateDialog } from "./region-dialogs";

const faint: React.CSSProperties = { color: "var(--ms-faint)" };
const muted: React.CSSProperties = { color: "var(--ms-muted)" };
const key: React.CSSProperties = { color: "var(--ms-info)" };

type CheckTone = "success" | "warn" | "danger" | "neutral";

function Check({
  tone,
  children,
  trailing,
  last,
}: {
  tone: CheckTone;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: "var(--ms-fs-label)",
        padding: "7px 0",
        borderBottom: last ? 0 : "1px solid var(--ms-line)",
      }}
    >
      <span className="ms-dot" style={{ background: `var(--ms-${tone})` }} />
      {children}
      {trailing ? (
        <span className="ms-mono" style={{ marginLeft: "auto", fontSize: 12, ...muted }}>
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

function Step({ n, last, children }: { n: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 18 }}>
      <div
        aria-hidden="true"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: 20,
          flex: "none",
        }}
      >
        <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-bone)" }}>
          {n}
        </span>
        {last ? null : (
          <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 22 }}>{children}</div>
    </div>
  );
}

const h4: React.CSSProperties = { margin: "0 0 4px", fontSize: 15, fontWeight: 600 };
const p: React.CSSProperties = { margin: "0 0 8px", fontSize: 13, color: "var(--ms-muted)" };

/**
 * The three-step "Add region" walkthrough for the region the URL names:
 * the setup tool's transcript, the .env lines, and the checks the console
 * can already see for a region it serves.
 */
export function AddRegionPanel({
  region,
  served,
  envRegions,
}: {
  region: string;
  /** The live row when the region is already served; the checks reflect it. */
  served: ServedRegion | undefined;
  envRegions: string[];
}) {
  const t = useTranslations("console.regions.add");
  const domains = useTranslations("domains");
  const [template, setTemplate] = useState(false);
  const flag = regionFlag(region);
  const home = envRegions[0] ?? region;
  const all = envRegions.includes(region) ? envRegions : [...envRegions, region];
  const arn = (r: string) => `arn:aws:sns:${r}:…:millionsend-events`;
  const check1: CheckTone = !served
    ? "neutral"
    : served.status === "serving"
      ? "success"
      : served.status === "sandbox"
        ? "warn"
        : "danger";

  return (
    <div className="ms-card" id="add-region" style={{ padding: 24, scrollMarginTop: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ margin: "0 0 4px", fontSize: "var(--ms-fs-section)", fontWeight: 600 }}>
            {t("title", { region: `${flag} ${region}` })}
          </h3>
          <p style={{ ...p, margin: 0 }}>{t("subtitle")}</p>
        </div>
        <span className="ms-badge ms-badge-neutral">{t("notStarted")}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <Step n="01">
          <h4 style={h4}>{t("step1")}</h4>
          <p style={p}>{t("step1Body")}</p>
          <pre className="ms-mono" style={codeBlock}>
            {"$ npx @millionsend/setup\n"}
            <span style={muted}>{t("cliRegion")}</span>
            {`  ${region}  `}
            <span style={faint}>{domains(`regions.${region}`)}</span>
            {"\n"}
            <span style={faint}>{t("cliAdopted")}</span>
            {"\n"}
            <span style={faint}>{t("cliPlan", { region })}</span>
            {"\n"}
            {`  ${t("cliTopic").padEnd(37)}`}
            <span style={key}>{region}</span>
            {"\n"}
            {`  ${t("cliSubscription")} `}
            <span style={key}>{home}</span> <span style={faint}>{t("cliCrossRegion")}</span>
            {"\n"}
            {`  ${t("cliConfigSet").padEnd(37)}`}
            <span style={key}>{region}</span>
            {"\n"}
            {`  ${t("cliSuppression").padEnd(37)}`}
            <span style={key}>{region}</span>
            {"\n"}
            <span style={muted}>{t("cliPricing")}</span> <span style={faint}>[y/N]</span>
            {"\n"}
            <span style={faint}>{t("cliEnv")}</span>
            {` AWS_REGIONS=${all.join(",")}  SNS_TOPIC_ARNS=…`}
          </pre>
        </Step>
        <Step n="02">
          <h4 style={h4}>{t("step2")}</h4>
          <pre className="ms-mono" style={codeBlock}>
            {`AWS_REGIONS=${all.join(",")}\nSNS_TOPIC_ARNS=${all.map(arn).join(",")}\n`}
            <span style={faint}>{t("queueNote")}</span>
          </pre>
          <p style={{ ...p, marginTop: 8 }}>
            <span className="ms-chip">AWS_REGION</span>{" "}
            {t("step2Note").replace(/^AWS_REGION\s*/, "")}
          </p>
        </Step>
        <Step n="03" last>
          <h4 style={h4}>{t("step3")}</h4>
          <p style={p}>{t("step3Body")}</p>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <Check
              tone={check1}
              trailing={
                check1 !== "warn" ? null : (
                  <button
                    type="button"
                    onClick={() => setTemplate(true)}
                    style={{
                      background: "none",
                      border: 0,
                      padding: 0,
                      font: "inherit",
                      color: "inherit",
                      cursor: "pointer",
                      textDecoration: "underline dotted var(--ms-faint)",
                      textUnderlineOffset: 3,
                    }}
                  >
                    {t("check1Link")}
                  </button>
                )
              }
            >
              {t(check1 === "success" ? "check1Production" : "check1")}
            </Check>
            <Check tone="neutral">{t("check2", { count: 6 })}</Check>
            <Check tone="neutral">{t("check3")}</Check>
            <Check tone="neutral" last>
              {t("check4")}
            </Check>
          </div>
        </Step>
      </div>
      {template ? <TemplateDialog region={region} open onClose={() => setTemplate(false)} /> : null}
    </div>
  );
}
