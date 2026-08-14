"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { BtnSpinner } from "@/components/spinner";
import { Tooltip } from "@/components/tooltip";
import {
  buildAwsSetupScript,
  CFN_DEPLOY_COMMAND,
  httpsOrigin,
  SES_IAM_POLICY_JSON,
} from "@/lib/aws-setup-script";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";

const PRODUCTION_ACCESS_DOCS_URL =
  "https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html";
const IAM_CREATE_POLICY_URL = "https://console.aws.amazon.com/iam/home#/policies/create";
const IAM_CREATE_USER_URL = "https://console.aws.amazon.com/iam/home#/users/create";

/* t.rich tag map: <code> in messages renders as an inline code pill. */
const richTags = {
  code: (chunks: React.ReactNode) => <code className="ms-code">{chunks}</code>,
};

/** Left rail of a stepper row: marker (✓ or number) above the connector line. */
function StepRail({ marker, done, line }: { marker: string; done: boolean; line: boolean }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 30,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <span
        className="ms-mono"
        style={{ fontSize: 11, color: done ? "var(--ms-success)" : "var(--ms-bone)" }}
      >
        {done ? "✓" : marker}
      </span>
      {line ? (
        <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
      ) : null}
    </div>
  );
}

function Step({
  marker,
  done = false,
  last = false,
  title,
  children,
}: {
  marker: string;
  done?: boolean;
  last?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 18 }}>
      <StepRail marker={marker} done={done} line={!last} />
      {/* minWidth 0 so wide <pre> content scrolls inside its block, never the page */}
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 24 }}>
        <h2
          className="ms-display"
          style={{
            fontSize: "var(--ms-fs-h2)",
            lineHeight: 1,
            color: "var(--ms-bone)",
            margin: "0 0 14px",
          }}
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function MonoBlock({
  title,
  value,
  maxHeight,
  collapsible = false,
}: {
  title: string;
  value: string;
  maxHeight?: number;
  collapsible?: boolean;
}) {
  const header = (
    <>
      <span className="ms-mono" style={{ fontSize: 11.5, color: "var(--ms-muted)" }}>
        {title}
      </span>
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
        {/* preventDefault keeps a copy click from toggling the disclosure; keyboard
            activation hits the copy button directly, so no key handler is needed */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: passthrough guard, not a control */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-default guard only */}
        <span onClick={collapsible ? (e) => e.preventDefault() : undefined}>
          <CopyGlyph value={value} />
        </span>
        {collapsible ? (
          <span style={{ color: "var(--ms-muted)" }} aria-hidden="true">
            ⌄
          </span>
        ) : null}
      </span>
    </>
  );
  const pre = (
    <pre
      className="ms-mono"
      style={{
        margin: 0,
        padding: "13px 16px",
        fontSize: 12,
        lineHeight: 1.65,
        color: "var(--ms-bone)",
        overflow: "auto",
        maxHeight,
        borderTop: "1px solid var(--ms-line)",
      }}
    >
      {value}
    </pre>
  );
  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: "7px 12px",
  };
  return (
    <div
      style={{
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        borderRadius: "var(--ms-r-input)",
        overflow: "hidden",
        maxWidth: "100%",
      }}
    >
      {collapsible ? (
        <details>
          <summary style={{ ...headerStyle, cursor: "pointer", listStyle: "none" }}>
            {header}
          </summary>
          {pre}
        </details>
      ) : (
        <>
          <div style={headerStyle}>{header}</div>
          {pre}
        </>
      )}
    </div>
  );
}

function CheckRow({ ok, name, detail }: { ok: boolean; name: string; detail: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid var(--ms-line)",
      }}
    >
      <span
        className="ms-mono"
        style={{
          fontSize: 11,
          width: 14,
          flex: "none",
          color: ok ? "var(--ms-success)" : "var(--ms-warn)",
        }}
        aria-hidden="true"
      >
        {ok ? "✓" : "✗"}
      </span>
      <span className="ms-mono" style={{ fontSize: 12.5, color: "var(--ms-bone)" }}>
        {name}
      </span>
      <span style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>{detail}</span>
    </div>
  );
}

function QuotaFigure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div>
      <div className="ms-microlabel">{label}</div>
      <div
        className="ms-digits"
        style={{ fontSize: "var(--ms-fs-kpi)", color: "var(--ms-bone)", marginTop: 6 }}
      >
        {value}
        {unit ? (
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ms-muted)" }}> {unit}</span>
        ) : null}
      </div>
    </div>
  );
}

const stepBodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ms-bone)",
};

export function SesSetupView() {
  const t = useTranslations("settings.ses");
  const locale = useLocale();
  const trpc = useTRPC();
  const readiness = useQuery(trpc.system.awsReadiness.queryOptions());
  const sesEnv = useQuery(trpc.system.sesEnv.queryOptions());
  // On demand only: GetAccount runs when the operator clicks "Test connection".
  const test = useQuery(
    trpc.system.sesAccount.queryOptions(undefined, { enabled: false, retry: false }),
  );
  if (!readiness.data || !sesEnv.data) return null;

  const fmt = new Intl.NumberFormat(locale);
  const result = test.data;
  const credentialsOk = readiness.data.credentialsConfigured;
  const eventsOk = sesEnv.data.snsTopicsConfigured && sesEnv.data.configurationSetConfigured;
  const eventsIncluded = httpsOrigin(sesEnv.data.appBaseUrl) !== null;
  const setupScript = buildAwsSetupScript({
    region: readiness.data.region,
    appBaseUrl: sesEnv.data.appBaseUrl,
    includeEvents: true,
  });

  return (
    <div style={{ maxWidth: 880 }}>
      <Step marker="01" title={t("setup.stepTitle")}>
        <section
          style={{
            backgroundColor: "var(--ms-ground)",
            backgroundImage: statusGlow("success", 15),
            border: "1px solid var(--ms-success-border)",
            borderRadius: "var(--ms-r-card)",
            padding: 22,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {t("setup.scriptTitle")}
            </span>
            <span className="ms-badge ms-badge-success">{t("setup.recommended")}</span>
          </div>
          <p style={{ margin: "10px 0 14px", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("setup.scriptNote")}
          </p>
          {eventsIncluded ? null : (
            <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--ms-warn)" }}>
              {t.rich("setup.eventsSkipped", richTags)}
            </p>
          )}
          <MonoBlock
            title="millionsend-aws-setup.sh"
            value={setupScript}
            maxHeight={300}
            collapsible
          />
          <p
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              margin: "12px 0 0",
              fontSize: 12.5,
              color: "var(--ms-muted)",
            }}
          >
            {t("setup.cfnNote")}
            <CopyChip value={CFN_DEPLOY_COMMAND} display="aws cloudformation deploy …" />
          </p>
        </section>

        <section className="ms-card" style={{ padding: 24, marginTop: 14 }}>
          <details>
            <summary
              style={{
                display: "flex",
                justifyContent: "space-between",
                cursor: "pointer",
                listStyle: "none",
                fontSize: 13.5,
                color: "var(--ms-bone)",
              }}
            >
              <span>{t("setup.manualTitle")}</span>
              <span style={{ color: "var(--ms-muted)" }}>⌄</span>
            </summary>
            <ol
              style={{
                margin: "18px 0 0",
                padding: "0 0 0 22px",
                display: "grid",
                gap: 16,
              }}
            >
              <li style={stepBodyStyle}>
                {t("setup.step1")}
                <div style={{ margin: "10px 0" }}>
                  <MonoBlock title="iam-policy.json" value={SES_IAM_POLICY_JSON} />
                </div>
                <a
                  href={IAM_CREATE_POLICY_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="ms-btn ms-btn-secondary"
                >
                  {t("setup.step1Link")} ↗
                </a>
              </li>
              <li style={stepBodyStyle}>
                {t("setup.step2")}{" "}
                <a href={IAM_CREATE_USER_URL} target="_blank" rel="noreferrer">
                  {t("setup.step2Link")} ↗
                </a>
              </li>
              <li style={stepBodyStyle}>{t("setup.step3")}</li>
              <li style={stepBodyStyle}>{t("setup.step4")}</li>
            </ol>
          </details>
        </section>
      </Step>

      <Step marker="02" done={credentialsOk} title={t("credentials.title")}>
        <section className="ms-card" style={{ padding: 24 }}>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("subtitle")}
          </p>
          <div>
            <CheckRow
              ok={credentialsOk}
              name="AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY"
              detail={credentialsOk ? t("credentials.keysConfigured") : t("credentials.keysChain")}
            />
            <CheckRow
              ok
              name="AWS_REGION"
              detail={<span className="ms-mono">{readiness.data.region}</span>}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={!credentialsOk || test.isFetching}
              onClick={() => test.refetch()}
            >
              <BtnSpinner on={test.isFetching} />
              {t("test.button")}
            </button>
            <Tooltip text={t.rich("test.note", richTags)} />
            {credentialsOk ? null : (
              <span style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
                {t("test.disabledHint")}
              </span>
            )}
          </div>

          {result?.ok ? (
            <>
              <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
                <span
                  className={`ms-badge ${result.sendingEnabled ? "ms-badge-success" : "ms-badge-danger"}`}
                >
                  {result.sendingEnabled ? t("test.sendingEnabled") : t("test.sendingDisabled")}
                </span>
                <span
                  className={`ms-badge ${result.productionAccess ? "ms-badge-success" : "ms-badge-warn"}`}
                >
                  {result.productionAccess ? t("test.production") : t("test.sandbox")}
                </span>
              </div>
              <div style={{ display: "flex", gap: 48, marginTop: 18 }}>
                <QuotaFigure label={t("test.quotaMax")} value={fmt.format(result.quota.max24h)} />
                <QuotaFigure
                  label={t("test.quotaSent")}
                  value={fmt.format(result.quota.sentLast24h)}
                />
                <QuotaFigure
                  label={t("test.quotaRate")}
                  value={fmt.format(result.quota.maxSendRate)}
                  unit={t("test.ratePerSecond")}
                />
              </div>
              {result.productionAccess ? null : (
                <div
                  style={{
                    border: "1px solid var(--ms-warn-border)",
                    background: "var(--ms-warn-bg)",
                    borderRadius: "var(--ms-r-input)",
                    padding: "11px 15px",
                    marginTop: 18,
                    fontSize: 13,
                    lineHeight: 1.55,
                  }}
                >
                  <span style={{ color: "var(--ms-warn)" }}>{t("test.sandboxTitle")}</span>{" "}
                  <span style={{ color: "var(--ms-bone)" }}>{t("test.sandboxBody")}</span>{" "}
                  <a href={PRODUCTION_ACCESS_DOCS_URL} target="_blank" rel="noreferrer">
                    {t("test.sandboxLink")} ↗
                  </a>
                </div>
              )}
              {sesEnv.data.maxSendRate !== result.quota.maxSendRate ? (
                <p
                  className="ms-mono"
                  style={{ margin: "12px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
                >
                  {t("test.rateHint", {
                    envRate: sesEnv.data.maxSendRate,
                    accountRate: result.quota.maxSendRate,
                  })}
                </p>
              ) : null}
            </>
          ) : null}

          {result && !result.ok ? (
            <>
              <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--ms-danger)" }}>
                {t.rich(`test.errors.${result.kind}`, richTags)}
              </p>
              <p
                className="ms-mono"
                style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
              >
                {result.message}
              </p>
            </>
          ) : null}
        </section>
      </Step>

      <Step marker="03" done={eventsOk} last title={t("events.title")}>
        <section className="ms-card" style={{ padding: 24 }}>
          <CheckRow
            ok={sesEnv.data.snsTopicsConfigured}
            name="SNS_TOPIC_ARNS"
            detail={
              sesEnv.data.snsTopicsConfigured ? t("credentials.set") : t("credentials.snsNote")
            }
          />
          <CheckRow
            ok={sesEnv.data.configurationSetConfigured}
            name="SES_CONFIGURATION_SET"
            detail={
              sesEnv.data.configurationSetConfigured
                ? t("credentials.set")
                : t("credentials.configSetNote")
            }
          />
        </section>
      </Step>

      {credentialsOk || result?.ok ? (
        <section className="ms-card" style={{ padding: 24, marginTop: 24 }}>
          <h2
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 18px" }}
          >
            {t("next.title")}
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/domains/new" className="ms-btn ms-btn-secondary">
              {t("next.addDomain")} →
            </Link>
            <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>{t("next.selfHosting")}</span>
          </div>
        </section>
      ) : null}
    </div>
  );
}
