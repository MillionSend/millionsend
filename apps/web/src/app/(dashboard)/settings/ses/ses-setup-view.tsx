"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";

const PRODUCTION_ACCESS_DOCS_URL =
  "https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html";

/** Every SES action the instance issues — SELF_HOSTING.md documents the same set. */
const IAM_POLICY = JSON.stringify(
  {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:CreateEmailIdentity",
          "ses:GetEmailIdentity",
          "ses:DeleteEmailIdentity",
          "ses:PutEmailIdentityMailFromAttributes",
          "ses:GetAccount",
        ],
        Resource: "*",
      },
    ],
  },
  null,
  2,
);

function envTemplate(region: string): string {
  return [
    `AWS_REGION=${region}`,
    "AWS_ACCESS_KEY_ID=",
    "AWS_SECRET_ACCESS_KEY=",
    "SNS_TOPIC_ARNS=",
    "SES_CONFIGURATION_SET=",
    "SES_MAX_SEND_RATE=1",
    "",
  ].join("\n");
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <h2
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 18px" }}
      >
        {title}
      </h2>
      {children}
    </section>
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

  return (
    <div style={{ display: "grid", gap: 20, maxWidth: 880 }}>
      <SectionCard title={t("credentials.title")}>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("subtitle")}
        </p>
        <div>
          <CheckRow
            ok={readiness.data.credentialsConfigured}
            name="AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY"
            detail={
              readiness.data.credentialsConfigured
                ? t("credentials.keysConfigured")
                : t("credentials.keysChain")
            }
          />
          <CheckRow
            ok
            name="AWS_REGION"
            detail={<span className="ms-mono">{readiness.data.region}</span>}
          />
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
        </div>
        <div style={{ marginTop: 16 }}>
          <CopyChip
            value={envTemplate(readiness.data.region)}
            display={t("credentials.envTemplate")}
          />
        </div>
        <div
          style={{
            background: "var(--ms-inset)",
            border: "1px solid var(--ms-line)",
            borderRadius: "var(--ms-r-input)",
            overflow: "hidden",
            marginTop: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "7px 12px",
              borderBottom: "1px solid var(--ms-line)",
            }}
          >
            <span className="ms-mono" style={{ fontSize: 11.5, color: "var(--ms-muted)" }}>
              {t("credentials.policyTitle")}
            </span>
            <span style={{ marginLeft: "auto" }}>
              <CopyGlyph value={IAM_POLICY} />
            </span>
          </div>
          <pre
            className="ms-mono"
            style={{
              margin: 0,
              padding: "13px 16px",
              fontSize: 12,
              lineHeight: 1.65,
              color: "var(--ms-bone)",
              overflowX: "auto",
            }}
          >
            {IAM_POLICY}
          </pre>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("credentials.policyNote")}
        </p>
      </SectionCard>

      <SectionCard title={t("test.title")}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={test.isFetching}
            onClick={() => test.refetch()}
          >
            <BtnSpinner on={test.isFetching} />
            {t("test.button")}
          </button>
          <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
            {t("test.note")}
          </span>
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
              {t(`test.errors.${result.kind}`)}
            </p>
            <p
              className="ms-mono"
              style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
            >
              {result.message}
            </p>
          </>
        ) : null}
      </SectionCard>

      <SectionCard title={t("next.title")}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/domains/new" className="ms-btn ms-btn-secondary">
            {t("next.addDomain")} →
          </Link>
          <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>{t("next.selfHosting")}</span>
        </div>
      </SectionCard>
    </div>
  );
}
