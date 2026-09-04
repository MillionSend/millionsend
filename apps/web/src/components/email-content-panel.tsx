"use client";

import type { EmailCheckResult, ScoreBand } from "@millionsend/core";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { CodeHighlight } from "@/components/code-highlight";
import { CopyButton, CopyGlyph } from "@/components/copy-chip";
import { Drawer } from "@/components/drawer";
import { PreviewSchemePills } from "@/components/preview-scheme-pills";
import { Switch } from "@/components/switch";
import { emulateEmailScheme } from "@/lib/email-preview";
import { formatDayTime } from "@/lib/format";
import { formatHtml } from "@/lib/html";
import { BAND_TONE, checkGlyph, formatScoreTenths } from "@/lib/score-band";
import { usePreviewScheme } from "@/lib/use-preview-scheme";

/** The HTML tab's source: pretty-printed by default, highlighted either way. */
function HtmlSource({ html, formatted }: { html: string; formatted: boolean }) {
  // Bodies run to hundreds of KB: format and highlight once per toggle, not
  // on every re-render of the page around them.
  const code = useMemo(
    () => <CodeHighlight code={formatted ? formatHtml(html) : html} language="xml" />,
    [html, formatted],
  );
  return (
    <pre
      className="ms-mono ms-hl"
      style={{
        margin: 0,
        padding: "16px 18px",
        fontSize: 12,
        lineHeight: 1.7,
        color: "var(--ms-bone)",
        overflowX: "auto",
      }}
    >
      {code}
    </pre>
  );
}

const TAB_KEYS = ["preview", "text", "html", "insights"] as const;
type Tab = (typeof TAB_KEYS)[number];

export interface EmailInsights {
  scoreTenths: number;
  band: ScoreBand;
  marketing: boolean;
  htmlSizeBytes: number | null;
  computedAt: Date;
  checks: EmailCheckResult[];
}

function InsightsSection({
  insights,
  email,
}: {
  insights: EmailInsights;
  email: { id: string; subject: string };
}) {
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const [openCheckId, setOpenCheckId] = useState<string | null>(null);
  const [naOpen, setNaOpen] = useState(false);

  const { checks } = insights;
  const groups = [
    {
      key: "attention",
      rows: checks.filter(
        (c) => c.status === "fail" && (c.severity === "critical" || c.severity === "major"),
      ),
    },
    {
      key: "improvements",
      rows: checks.filter(
        (c) => c.status === "fail" && (c.severity === "minor" || c.severity === "info"),
      ),
    },
    {
      key: "great",
      rows: checks.filter((c) => c.status === "pass" || c.status === "passed_by_design"),
    },
    { key: "notChecked", rows: checks.filter((c) => c.status === "unknown") },
  ] as const;
  const notApplicable = checks.filter((c) => c.status === "not_applicable");
  const openCheck = openCheckId ? checks.find((c) => c.id === openCheckId) : undefined;

  /** Mono data line under a check — hostnames, sizes, policies; never URLs. */
  function detailLine(check: EmailCheckResult): string | null {
    const d = check.detail;
    if (!d) return null;
    switch (check.id) {
      case "body_size":
        return typeof d.htmlSizeBytes === "number"
          ? t("insights.kb", { kb: Math.round(d.htmlSizeBytes / 1024) })
          : null;
      case "dmarc_record":
        return typeof d.policy === "string" ? `p=${d.policy}` : null;
      case "link_domains_match":
        return Array.isArray(d.linkDomains) ? d.linkDomains.join(", ") : null;
      case "no_shorteners":
        return Array.isArray(d.shorteners) ? d.shorteners.join(", ") : null;
      case "images_offsite":
        return Array.isArray(d.imageDomains) ? d.imageDomains.join(", ") : null;
      default:
        return null;
    }
  }

  function checkRow(check: EmailCheckResult, greyed = false) {
    const { glyph, color } = checkGlyph(check);
    return (
      <button
        key={check.id}
        type="button"
        onClick={() => setOpenCheckId(check.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          background: "none",
          border: 0,
          borderBottom: "1px solid var(--ms-line)",
          padding: "9px 2px",
          font: "inherit",
          color: greyed ? "var(--ms-faint)" : "var(--ms-bone)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ color, width: 14, flex: "none", fontSize: 12 }}>
          {glyph}
        </span>
        <span style={{ fontSize: 13.5 }}>{t(`insights.check.${check.id}.title`)}</span>
        {check.status === "passed_by_design" ? (
          <span className="ms-chip" style={{ fontSize: 10.5, padding: "1px 7px" }}>
            {t("insights.byDesign")}
          </span>
        ) : null}
        <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>
          ›
        </span>
      </button>
    );
  }

  return (
    <div style={{ padding: "20px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="ms-digits" style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1 }}>
          {formatScoreTenths(insights.scoreTenths, locale)}
        </span>
        <span className="ms-digits" style={{ fontSize: 15, color: "var(--ms-muted)" }}>
          {t("insights.outOfTen")}
        </span>
        <span className={`ms-badge ms-badge-${BAND_TONE[insights.band]}`}>
          {common(`band.${insights.band}`)}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 6 }}>
        {t("insights.reportFrom", { date: formatDayTime(insights.computedAt, locale) })}
      </div>

      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <div key={group.key} style={{ marginTop: 20 }}>
            <div className="ms-microlabel">{t(`insights.groups.${group.key}`)}</div>
            {group.key === "notChecked" ? (
              <div style={{ fontSize: 12.5, color: "var(--ms-faint)", marginTop: 3 }}>
                {t("insights.notCheckedWhy")}
              </div>
            ) : null}
            <div style={{ marginTop: 4 }}>{group.rows.map((check) => checkRow(check))}</div>
          </div>
        ),
      )}

      {notApplicable.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <button
            type="button"
            className="ms-microlabel"
            onClick={() => setNaOpen((v) => !v)}
            style={{
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {t("insights.notApplicableToggle", { count: notApplicable.length })}
            <span aria-hidden="true">{naOpen ? "▾" : "›"}</span>
          </button>
          {naOpen ? (
            <div style={{ marginTop: 4 }}>
              {notApplicable.map((check) => checkRow(check, true))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Drawer
        open={openCheck !== undefined}
        onClose={() => setOpenCheckId(null)}
        title={openCheck ? t(`insights.check.${openCheck.id}.title`) : ""}
      >
        {openCheck ? (
          <>
            <p style={{ fontSize: 13.5, color: "var(--ms-muted)", lineHeight: 1.6, marginTop: 16 }}>
              {t(`insights.check.${openCheck.id}.description`)}
            </p>
            {openCheck.status === "passed_by_design" ? (
              <p style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.6 }}>
                {t("insights.byDesignNote")}
              </p>
            ) : null}
            {openCheck.status === "unknown" ? (
              <p style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.6 }}>
                {t("insights.notCheckedWhy")}
              </p>
            ) : null}
            <div className="ms-microlabel" style={{ margin: "18px 0 6px" }}>
              {t("insights.adviceLabel")}
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ms-bone)", lineHeight: 1.6 }}>
              {t(`insights.check.${openCheck.id}.advice`)}
            </p>
            {detailLine(openCheck) ? (
              <>
                <div className="ms-microlabel" style={{ margin: "18px 0 6px" }}>
                  {t("insights.detailLabel")}
                </div>
                <div
                  className="ms-mono"
                  style={{ fontSize: 12.5, color: "var(--ms-bone)", overflowWrap: "anywhere" }}
                >
                  {detailLine(openCheck)}
                </div>
              </>
            ) : null}
            {openCheck.status === "fail" ? (
              <>
                <div className="ms-microlabel" style={{ margin: "18px 0 6px" }}>
                  {t("insights.handoffLabel")}
                </div>
                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 13,
                    color: "var(--ms-muted)",
                    lineHeight: 1.6,
                  }}
                >
                  {t("insights.handoffHint")}
                </p>
                <CopyButton
                  value={t("insights.agentPrompt", {
                    subject: email.subject,
                    id: email.id,
                    title: t(`insights.check.${openCheck.id}.title`),
                    description: t(`insights.check.${openCheck.id}.description`),
                    advice: t(`insights.check.${openCheck.id}.advice`),
                    detail: detailLine(openCheck)
                      ? `\n${t("insights.detailLabel")}: ${detailLine(openCheck)}`
                      : "",
                  })}
                  label={t("insights.copyForAgent")}
                />
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}

/**
 * The message as sent, one panel for every surface that holds a message:
 * preview as a light or dark mail client, plain text, source, and the
 * insights report. Email and broadcast detail render this same panel.
 */
export function EmailContentPanel({
  email,
}: {
  email: {
    id: string;
    subject: string;
    html: string | null;
    text: string | null;
    insights: EmailInsights | null;
    bodyPurgedAt?: Date | null | undefined;
  };
}) {
  const t = useTranslations("emails");
  const [tab, setTab] = useState<Tab>("preview");
  const [scheme, setScheme] = usePreviewScheme();
  const [htmlFormatted, setHtmlFormatted] = useState(true);
  const tabContent: Record<Tab, string | null> = {
    preview: email.html,
    text: email.text,
    html: email.html,
    insights: null,
  };
  const currentContent = tabContent[tab];
  const tabLabels: Record<Tab, string> = {
    preview: t("detail.preview"),
    text: t("detail.plainText"),
    html: t("detail.html"),
    insights: t("detail.insights"),
  };

  return (
    <div
      style={{
        background: "var(--ms-panel)",
        border: "1px solid var(--ms-line)",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {/* The tab bar outlives the body purge: insights are content-derived
        metadata and deliberately survive it, so the purge message replaces
        only the preview/text/html panels. */}
      <div
        className="ms-scroll-x"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 12px",
          borderBottom: "1px solid var(--ms-line)",
          // One line that scrolls sideways on a phone: a tab that wraps
          // under its neighbours reads as a different control.
          overflowX: "auto",
          flexWrap: "nowrap",
        }}
      >
        {TAB_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            style={{
              flex: "none",
              whiteSpace: "nowrap",
              fontSize: 13,
              padding: "5px 11px",
              borderRadius: 8,
              border: 0,
              cursor: "pointer",
              background: tab === key ? "var(--ms-panel-raised)" : "none",
              color: tab === key ? "var(--ms-bone)" : "var(--ms-muted)",
              font: "inherit",
            }}
            onClick={() => setTab(key)}
          >
            {tabLabels[key]}
          </button>
        ))}
        {currentContent ? (
          <span
            style={{
              marginLeft: "auto",
              padding: "0 6px",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flex: "none",
            }}
          >
            {tab === "preview" && email.html ? (
              <PreviewSchemePills scheme={scheme} onChange={setScheme} />
            ) : null}
            {tab === "html" ? (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--ms-muted)",
                }}
              >
                {t("detail.formatted")}
                <Switch
                  checked={htmlFormatted}
                  disabled={false}
                  onChange={setHtmlFormatted}
                  ariaLabel={t("detail.formatted")}
                />
              </span>
            ) : null}
            {/* Copies the source as sent, never the re-flowed view. */}
            <CopyGlyph value={currentContent} />
          </span>
        ) : null}
      </div>
      {tab === "insights" ? (
        email.insights ? (
          <InsightsSection
            insights={email.insights}
            email={{ id: email.id, subject: email.subject }}
          />
        ) : (
          <div style={{ padding: "16px 18px" }}>
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
              {t("insights.empty")}
            </p>
            <p style={{ margin: "6px 0 0", color: "var(--ms-faint)", fontSize: 13 }}>
              {t("insights.emptyHint")}
            </p>
          </div>
        )
      ) : email.bodyPurgedAt ? (
        <p
          style={{
            margin: 0,
            padding: "16px 18px",
            color: "var(--ms-muted)",
            fontSize: "var(--ms-fs-ui)",
          }}
        >
          {t("detail.bodyPurged")}
        </p>
      ) : (
        <>
          {tab === "preview" &&
            (email.html ? (
              // Edge to edge: the message lays itself out inside the frame,
              // as it would in a mail client.
              <iframe
                title={t("detail.preview")}
                sandbox=""
                srcDoc={emulateEmailScheme(email.html, scheme)}
                style={{
                  display: "block",
                  width: "100%",
                  height: 640,
                  border: 0,
                  borderRadius: "0 0 12px 12px",
                  background: scheme === "dark" ? "#111113" : "#ffffff",
                }}
              />
            ) : (
              <p
                style={{
                  margin: 0,
                  padding: "16px 18px",
                  color: "var(--ms-muted)",
                  fontSize: "var(--ms-fs-ui)",
                }}
              >
                {t("detail.noHtml")}
              </p>
            ))}
          {tab === "text" &&
            (email.text ? (
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  margin: 0,
                  padding: "16px 18px",
                  fontFamily: "var(--ms-font-sans)",
                  fontSize: "var(--ms-fs-ui)",
                  lineHeight: 1.7,
                }}
              >
                {email.text}
              </pre>
            ) : (
              <p
                style={{
                  margin: 0,
                  padding: "16px 18px",
                  color: "var(--ms-muted)",
                  fontSize: "var(--ms-fs-ui)",
                }}
              >
                {t("detail.noText")}
              </p>
            ))}
          {tab === "html" &&
            (email.html ? (
              <HtmlSource html={email.html} formatted={htmlFormatted} />
            ) : (
              <p
                style={{
                  margin: 0,
                  padding: "16px 18px",
                  color: "var(--ms-muted)",
                  fontSize: "var(--ms-fs-ui)",
                }}
              >
                {t("detail.noHtml")}
              </p>
            ))}
        </>
      )}
    </div>
  );
}
