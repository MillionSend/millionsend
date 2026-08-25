"use client";

import { httpsOrigin, SES_IAM_POLICY_JSON } from "@millionsend/ses/setup-constants";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { ChevronGlyph } from "@/components/icons/nav-icons";
import { Skeleton, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Tooltip } from "@/components/tooltip";
import { buildAwsSetupScript, CFN_DEPLOY_COMMAND, cfnQuickCreateUrl } from "@/lib/aws-setup-script";
import { codeRichTags } from "@/lib/code-rich-tags";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";

const PRODUCTION_ACCESS_DOCS_URL =
  "https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html";
const IAM_CREATE_POLICY_URL = "https://console.aws.amazon.com/iam/home#/policies/create";
const IAM_CREATE_USER_URL = "https://console.aws.amazon.com/iam/home#/users/create";

/** Left rail of a stepper row: marker (✓ or number) above the connector line. */
function StepRail({ marker, done, line }: { marker: string; done: boolean; line: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="ms-stepper-rail"
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
    <div className="ms-step" style={{ display: "flex", gap: 18 }}>
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
  const [open, setOpen] = useState(false);
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
          <span style={{ display: "flex", alignItems: "center", color: "var(--ms-muted)" }}>
            <ChevronGlyph direction={open ? "up" : "down"} />
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
        <details onToggle={(e) => setOpen(e.currentTarget.open)}>
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

/* Cards must span the step content column; border-box because there is no
   global box-sizing reset, so width:100% + padding would otherwise overflow. */
const stepCardStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box" };

const stepBodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ms-bone)",
};

/** Compact card shown once a step's env vars are in place; the toggle reveals
    the full instruction stack the step would otherwise show. */
function StepDoneCard({
  message,
  toggleLabel,
  open,
  onToggle,
  small = false,
}: {
  message: string;
  toggleLabel: string;
  open: boolean;
  onToggle: () => void;
  small?: boolean;
}) {
  return (
    <section
      style={{
        ...stepCardStyle,
        display: "flex",
        alignItems: "center",
        gap: 10,
        backgroundColor: "var(--ms-ground)",
        backgroundImage: statusGlow("success", 15),
        border: "1px solid var(--ms-success-border)",
        borderRadius: 14,
        padding: small ? "12px 16px" : "16px 22px",
      }}
    >
      <span
        className="ms-mono"
        aria-hidden="true"
        style={{ fontSize: 11, color: "var(--ms-success)" }}
      >
        ✓
      </span>
      <span style={{ fontSize: small ? 13 : 13.5, color: "var(--ms-bone)" }}>{message}</span>
      <button
        type="button"
        className="ms-btn ms-btn-ghost"
        aria-expanded={open}
        style={{ marginLeft: "auto" }}
        onClick={onToggle}
      >
        {toggleLabel}
      </button>
    </section>
  );
}

export function SesSetupView() {
  const t = useTranslations("settings.ses");
  const [manualOpen, setManualOpen] = useState(false);
  // Collapsed on every load: the done cards only remember the toggle in-page.
  const [setupDetailsOpen, setSetupDetailsOpen] = useState(false);
  const [eventsDetailsOpen, setEventsDetailsOpen] = useState(false);
  const locale = useLocale();
  const trpc = useTRPC();
  // Poll while credentials are missing so the step markers flip live once the
  // operator's CLI run lands in .env and the server restarts.
  const readiness = useQuery(
    trpc.system.awsReadiness.queryOptions(undefined, {
      refetchInterval: (query) => (query.state.data?.credentialsConfigured ? false : 5000),
    }),
  );
  const credentialsOk = readiness.data?.credentialsConfigured ?? false;
  const sesEnv = useQuery(
    trpc.system.sesEnv.queryOptions(undefined, {
      refetchInterval: credentialsOk ? false : 5000,
    }),
  );
  // On demand only: GetAccount runs when the operator clicks "Test connection".
  const test = useQuery(
    trpc.system.sesAccount.queryOptions(undefined, { enabled: false, retry: false }),
  );
  // Auto-run the connection test once when credentials flip from missing to
  // configured while the page is open (never on a page that loads configured).
  const testRefetch = test.refetch;
  const prevCredentialsOk = useRef<boolean | null>(null);
  const hasReadiness = readiness.data !== undefined;
  useEffect(() => {
    if (!hasReadiness) return;
    if (prevCredentialsOk.current === false && credentialsOk) void testRefetch();
    prevCredentialsOk.current = credentialsOk;
  }, [hasReadiness, credentialsOk, testRefetch]);
  if (!readiness.data || !sesEnv.data) {
    // Ghost of the stepper chrome while the env checks resolve — real rails
    // and titles (all static), card interiors as bars.
    return (
      <div style={{ maxWidth: 880 }}>
        <Step marker="01" title={t("setup.stepTitle")}>
          <section className="ms-card" style={{ ...stepCardStyle, padding: 22 }}>
            <div style={{ fontSize: 16, fontWeight: 600, display: "flex" }}>
              <Skeleton width={220} height="1lh" />
            </div>
            <p style={{ margin: "12px 0 0" }}>
              <SkeletonChip width={180} />
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 13, display: "flex" }}>
              <Skeleton width={320} height="1lh" />
            </p>
          </section>
        </Step>
        <Step marker="02" title={t("credentials.title")}>
          <section className="ms-card" style={{ ...stepCardStyle, padding: 24 }}>
            <p style={{ margin: "0 0 8px", fontSize: 13, display: "flex" }}>
              <Skeleton width={280} height="1lh" />
            </p>
            <div>
              {[300, 220].map((width) => (
                <div
                  key={width}
                  className="ms-mono"
                  style={{
                    padding: "8px 0",
                    borderBottom: "1px solid var(--ms-line)",
                    fontSize: 12.5,
                    display: "flex",
                  }}
                >
                  <Skeleton width={width} height="1lh" />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
              <Skeleton width={130} height={30} radius="var(--ms-r-input)" />
            </div>
          </section>
        </Step>
        <Step marker="03" last title={t("events.title")}>
          <section className="ms-card" style={{ ...stepCardStyle, padding: 24 }}>
            {[240, 280].map((width) => (
              <div
                key={width}
                className="ms-mono"
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid var(--ms-line)",
                  fontSize: 12.5,
                  display: "flex",
                }}
              >
                <Skeleton width={width} height="1lh" />
              </div>
            ))}
          </section>
        </Step>
      </div>
    );
  }

  const fmt = new Intl.NumberFormat(locale);
  const result = test.data;
  const eventsOk = sesEnv.data.snsTopicsConfigured && sesEnv.data.configurationSetConfigured;
  const eventsIncluded = httpsOrigin(sesEnv.data.appBaseUrl) !== null;
  const setupScript = buildAwsSetupScript({
    region: readiness.data.region,
    appBaseUrl: sesEnv.data.appBaseUrl,
    includeEvents: true,
  });

  return (
    <div style={{ maxWidth: 880 }}>
      <Step marker="01" done={credentialsOk} title={t("setup.stepTitle")}>
        {credentialsOk ? (
          <StepDoneCard
            message={t("setup.connected")}
            toggleLabel={t("setup.viewInstructions")}
            open={setupDetailsOpen}
            onToggle={() => setSetupDetailsOpen((v) => !v)}
          />
        ) : null}
        {!credentialsOk || setupDetailsOpen ? (
          <div style={{ marginTop: credentialsOk ? 14 : 0 }}>
            <section className="ms-card" style={{ ...stepCardStyle, padding: 22 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
                  {t("setup.cliTitle")}
                </span>
                <span className="ms-badge ms-badge-success">{t("setup.recommended")}</span>
              </div>
              <p style={{ margin: "12px 0 0" }}>
                <CopyChip value="npx @millionsend/setup" />
              </p>
              <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
                {t.rich("setup.cliNote", codeRichTags)}
              </p>
            </section>

            <section className="ms-card" style={{ ...stepCardStyle, padding: 22, marginTop: 14 }}>
              <a
                href={cfnQuickCreateUrl(readiness.data.region)}
                target="_blank"
                rel="noreferrer"
                className="ms-btn ms-btn-secondary"
              >
                {t("setup.cfnButton")} ↗
              </a>
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
                {t.rich("setup.cfnNote", codeRichTags)}
                <CopyChip value={CFN_DEPLOY_COMMAND} display="aws cloudformation deploy …" />
              </p>
            </section>

            <section className="ms-card" style={{ ...stepCardStyle, padding: 22, marginTop: 14 }}>
              <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
                {t("setup.scriptTitle")}
              </span>
              <p style={{ margin: "10px 0 14px", fontSize: 13, color: "var(--ms-muted)" }}>
                {t.rich("setup.scriptNote", codeRichTags)}
              </p>
              {eventsIncluded ? null : (
                <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--ms-warn)" }}>
                  {t.rich("setup.eventsSkipped", codeRichTags)}
                </p>
              )}
              <MonoBlock
                title="millionsend-aws-setup.sh"
                value={setupScript}
                maxHeight={300}
                collapsible
              />
            </section>

            <section className="ms-card" style={{ ...stepCardStyle, padding: 24, marginTop: 14 }}>
              <details onToggle={(e) => setManualOpen(e.currentTarget.open)}>
                <summary
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    cursor: "pointer",
                    listStyle: "none",
                    fontSize: 13.5,
                    color: "var(--ms-bone)",
                  }}
                >
                  <span>{t("setup.manualTitle")}</span>
                  <span style={{ display: "flex", alignItems: "center", color: "var(--ms-muted)" }}>
                    <ChevronGlyph direction={manualOpen ? "up" : "down"} />
                  </span>
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
                    {t.rich("setup.step2", codeRichTags)}{" "}
                    <a href={IAM_CREATE_USER_URL} target="_blank" rel="noreferrer">
                      {t("setup.step2Link")} ↗
                    </a>
                  </li>
                  <li style={stepBodyStyle}>{t.rich("setup.step3", codeRichTags)}</li>
                  <li style={stepBodyStyle}>{t.rich("setup.step4", codeRichTags)}</li>
                </ol>
              </details>
            </section>
          </div>
        ) : null}
      </Step>

      <Step marker="02" done={credentialsOk} title={t("credentials.title")}>
        <section className="ms-card" style={{ ...stepCardStyle, padding: 24 }}>
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
              ok={sesEnv.data.passwordRecoveryEnabled}
              name="AUTH_EMAIL_FROM"
              detail={
                sesEnv.data.passwordRecoveryEnabled
                  ? t("credentials.set")
                  : t("credentials.authEmailNote")
              }
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
            <Tooltip text={t.rich("test.note", codeRichTags)} />
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
              <div className="ms-kpi-row" style={{ display: "flex", gap: 48, marginTop: 18 }}>
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
                  <div style={{ marginTop: 12 }}>
                    <MonoBlock
                      title="production-access-request.txt"
                      value={t("test.requestTemplate")}
                      maxHeight={260}
                      collapsible
                    />
                  </div>
                  <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
                    {t.rich("test.requestTemplateNote", codeRichTags)}
                  </p>
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
                {t.rich(`test.errors.${result.kind}`, codeRichTags)}
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

      <Step
        marker="03"
        done={eventsOk}
        last={!(credentialsOk || result?.ok)}
        title={t("events.title")}
      >
        {eventsOk ? (
          <StepDoneCard
            small
            message={t("events.connected")}
            toggleLabel={t("setup.viewInstructions")}
            open={eventsDetailsOpen}
            onToggle={() => setEventsDetailsOpen((v) => !v)}
          />
        ) : null}
        {!eventsOk || eventsDetailsOpen ? (
          <section
            className="ms-card"
            style={{ ...stepCardStyle, padding: 24, marginTop: eventsOk ? 14 : 0 }}
          >
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
        ) : null}
      </Step>

      {credentialsOk || result?.ok ? (
        <Step marker="04" last title={t("next.title")}>
          <section className="ms-card" style={{ padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <Link href="/domains/new" className="ms-btn ms-btn-secondary">
                {t("next.addDomain")} →
              </Link>
              <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>
                {t.rich("next.selfHosting", codeRichTags)}
              </span>
            </div>
          </section>
        </Step>
      ) : null}
    </div>
  );
}
