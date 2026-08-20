"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";
import {
  type DnsRecord,
  DnsRecordsTable,
  DnsRecordsTableSkeleton,
} from "@/components/dns-records-table";
import { ChevronGlyph } from "@/components/icons/nav-icons";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { MarkerRail, MobileStepBar, StepRail } from "@/components/stepper";
import { Tooltip } from "@/components/tooltip";
import { isAwsCredentialError } from "@/lib/aws-errors";
import { codeRichTags } from "@/lib/code-rich-tags";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { AwsCredentialsBanner } from "../aws-credentials-banner";
import { DOMAIN_REGIONS, type DomainRegion, regionFlag } from "../regions";

// Client-side pre-check only; the router's zod schema is authoritative.
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const hintStyle: React.CSSProperties = {
  margin: "6px 0 0",
  color: "var(--ms-muted)",
  fontSize: 12,
};

function isConflict(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code === "CONFLICT";
}

/** Wizard step 02: the created domain's DNS records, rendered in-page after create. */
function DnsRecordsStep({ id }: { id: string }) {
  const t = useTranslations("domains");
  const router = useRouter();
  const trpc = useTRPC();
  const domain = useQuery(trpc.domains.get.queryOptions({ id }));
  const records = useQuery(trpc.domains.records.queryOptions({ id }));
  const provider = records.data?.provider ?? null;
  return (
    <div className="ms-step-col" style={{ display: "flex", flexDirection: "column" }}>
      <MobileStepBar steps={[t("new.steps.one"), t("new.steps.two")]} active={2} />
      {/* Step 01 — done: recap of the created domain */}
      <div className="ms-step" style={{ display: "flex", gap: 44 }}>
        <MarkerRail marker="01" done color="var(--ms-success)" />
        <div style={{ flex: 1, minWidth: 0, paddingBottom: 28 }}>
          <div
            style={{
              width: 520,
              maxWidth: "100%",
              backgroundColor: "var(--ms-ground)",
              backgroundImage: statusGlow("success", 15),
              border: "1px solid var(--ms-success-border)",
              borderRadius: "var(--ms-r-card)",
              padding: "18px 24px",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 16,
                fontWeight: 600,
                color: "var(--ms-bone)",
              }}
            >
              <span>{t("new.cardTitle")}</span>
              <span style={{ color: "var(--ms-success)", fontWeight: 400 }}>✓</span>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
              {t("new.recapSubtitle")}
            </p>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "var(--ms-inset)",
                border: "1px solid var(--ms-line)",
                borderRadius: "var(--ms-r-input)",
                padding: "6px 10px",
              }}
            >
              {domain.isSuccess ? (
                <>
                  <span>{regionFlag(domain.data.region)}</span>
                  <span
                    className="ms-mono"
                    style={{ fontSize: 13, color: "var(--ms-bone)", overflowWrap: "anywhere" }}
                  >
                    {domain.data.name}
                  </span>
                </>
              ) : (
                <>
                  {/* The loaded row's height comes from the flag span's line
                      box (base font-size × 1.55 line-height); a 1lh stand-in
                      reserves exactly that, and the mono line keeps its real
                      13px wrapper so nothing shifts when the domain lands. */}
                  <Skeleton width="1.2em" height="1lh" />
                  <span className="ms-mono" style={{ fontSize: 13, display: "flex" }}>
                    <Skeleton width={200} height="1lh" />
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Step 02 — fill in the DNS records */}
      <div className="ms-step" style={{ display: "flex", gap: 44 }}>
        <MarkerRail marker="02" color="var(--ms-bone)" line={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="ms-display" style={{ fontSize: 22, margin: 0, color: "var(--ms-bone)" }}>
            {provider
              ? t("new.recordsTitleProvider", { provider: provider.name })
              : t("new.recordsTitle")}
          </h2>

          {records.isError ? (
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 20 }}>
              <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)" }}>{t("detail.recordsError")}</p>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => records.refetch()}
              >
                {t("detail.retry")}
              </button>
            </div>
          ) : (
            <div style={{ marginTop: 22 }}>
              {records.isSuccess ? (
                <DnsRecordsTable
                  records={records.data.records as DnsRecord[]}
                  domain={domain.data?.name}
                />
              ) : (
                <DnsRecordsTableSkeleton />
              )}
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            {/* The detail page owns verification from here. */}
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => router.push(`/domains/${id}`)}
            >
              {t("new.addedRecords")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AddDomainForm({ userEmail }: { userEmail: string }) {
  const t = useTranslations("domains");
  const router = useRouter();
  const trpc = useTRPC();
  const team = useQuery(trpc.settings.team.get.queryOptions());
  const [name, setName] = useState("");
  const readiness = useQuery(trpc.system.awsReadiness.queryOptions());
  const provisionedRegion = readiness.data?.region as DomainRegion | undefined;
  const [region, setRegion] = useState<DomainRegion>("us-east-1");
  useEffect(() => {
    if (provisionedRegion) setRegion(provisionedRegion);
  }, [provisionedRegion]);
  const [returnPath, setReturnPath] = useState("send");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  // Step 02 lives at ?created=<id> so a refresh (or shared link) lands back on
  // the new domain's records instead of an empty form.
  const createdId = useSearchParams().get("created");
  const create = useMutation(
    trpc.domains.create.mutationOptions({
      onSuccess: ({ id }) => router.replace(`/domains/new?created=${id}`),
    }),
  );

  const nameValid = HOSTNAME_RE.test(name);
  const showNameError = touched && name.length > 0 && !nameValid;
  const previewDomain = name || t("new.namePlaceholder");
  const teamName = team.data?.name ?? "";

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!nameValid || create.isPending) return;
    create.mutate({ name, region, mailFromSubdomain: returnPath });
  }

  if (createdId) return <DnsRecordsStep id={createdId} />;

  return (
    <>
      <AwsCredentialsBanner />
      <div className="ms-stepper" style={{ display: "flex", gap: 44, alignItems: "flex-start" }}>
        <MobileStepBar steps={[t("new.steps.one"), t("new.steps.two")]} active={1} />
        <StepRail current={1} />

        <form
          onSubmit={onSubmit}
          style={{
            width: 520,
            flex: "none",
            background: "var(--ms-panel)",
            border: "1px solid var(--ms-line-strong)",
            borderRadius: "var(--ms-r-card)",
            padding: 24,
            boxSizing: "border-box",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
            {t("new.cardTitle")}
          </div>

          <div className="ms-field" style={{ marginTop: 16 }}>
            <label htmlFor="domain-name">{t("new.name")}</label>
            <input
              id="domain-name"
              type="text"
              className={`ms-input mono${showNameError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("new.namePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              value={name}
              disabled={create.isPending}
              onChange={(e) => setName(e.target.value.trim().toLowerCase())}
              onBlur={() => setTouched(true)}
            />
            {showNameError ? (
              <p style={{ ...hintStyle, color: "var(--ms-danger)" }}>
                {t.rich("new.nameError", codeRichTags)}
              </p>
            ) : (
              <p style={hintStyle}>{t("new.nameHint")}</p>
            )}
          </div>

          <div className="ms-field" style={{ marginTop: 14 }}>
            <div className="ms-label-row">
              <label htmlFor="domain-region">{t("new.region")}</label>
              <Tooltip text={t("new.regionHint")} />
            </div>
            <Select
              id="domain-region"
              width="100%"
              value={region}
              disabled={create.isPending}
              onChange={(value) => setRegion(value as DomainRegion)}
              ariaLabel={t("new.region")}
              // Only the provisioned region: configuration sets and SNS
              // topics are regional, so other regions would send blind.
              options={(provisionedRegion ? [provisionedRegion] : DOMAIN_REGIONS).map((code) => ({
                value: code,
                label: `${regionFlag(code)} ${t(`regions.${code}`)} (${code})`,
              }))}
            />
          </div>

          <details
            style={{
              marginTop: 18,
              borderTop: "1px solid var(--ms-line)",
              paddingTop: 14,
            }}
            onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
          >
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
              <span>{t("new.advanced")}</span>
              <span style={{ display: "flex", alignItems: "center", color: "var(--ms-muted)" }}>
                <ChevronGlyph direction={advancedOpen ? "up" : "down"} />
              </span>
            </summary>
            <div className="ms-field" style={{ marginTop: 14 }}>
              <label htmlFor="domain-return-path">{t("new.returnPath")}</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="domain-return-path"
                  type="text"
                  className="ms-input mono"
                  style={{ width: 120 }}
                  autoComplete="off"
                  spellCheck={false}
                  value={returnPath}
                  disabled={create.isPending}
                  onChange={(e) => setReturnPath(e.target.value.trim().toLowerCase())}
                />
                <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                  .{previewDomain}
                </span>
              </div>
              <p style={hintStyle}>{t.rich("new.returnPathHint", codeRichTags)}</p>
            </div>
          </details>

          {create.isError ? (
            <p style={{ margin: "14px 0 0", color: "var(--ms-danger)", fontSize: 13 }}>
              {isConflict(create.error)
                ? t("new.conflict")
                : isAwsCredentialError(create.error.message)
                  ? t.rich("new.credentialsError", codeRichTags)
                  : create.error.message || t("new.error")}
            </p>
          ) : null}

          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            style={{ marginTop: 20 }}
            disabled={create.isPending || name.length === 0}
          >
            <BtnSpinner on={create.isPending} />
            {t("new.submit")}
          </button>
        </form>

        <div className="ms-stepper-side" style={{ flex: 1, minWidth: 0 }}>
          <p className="ms-microlabel" style={{ margin: "0 0 10px" }}>
            {t("new.preview.title")}
          </p>
          <div className="ms-mail-preview">
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "var(--ms-bone)",
                  color: "var(--ms-ground)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 15,
                  fontWeight: 600,
                  flex: "none",
                }}
              >
                {teamName.charAt(0).toUpperCase() || "@"}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, color: "var(--ms-bone)", fontWeight: 600 }}>
                  {teamName}{" "}
                  <span style={{ fontWeight: 400, color: "var(--ms-muted)" }}>
                    {`<${t("new.preview.user")}@${previewDomain}>`}
                  </span>
                </div>
                <button
                  type="button"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setDetailsOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    color: "var(--ms-muted)",
                    background: "none",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  {t("new.preview.toMe")}
                  {/* Optical nudge: flex-center aligns to the text line box, which
                      reserves descender space, leaving a small glyph above the
                      lowercase optical center. 1px down re-centers it. */}
                  <span style={{ display: "inline-flex", transform: "translateY(1px)" }}>
                    <ChevronGlyph size={10} direction={detailsOpen ? "up" : "down"} />
                  </span>
                </button>
              </div>
            </div>
            {detailsOpen ? (
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: "1px solid var(--ms-line)",
                  display: "grid",
                  gridTemplateColumns: "max-content 1fr",
                  columnGap: 12,
                  rowGap: 4,
                  fontSize: 12.5,
                  animation: "ms-fade 120ms var(--ms-ease) both",
                }}
              >
                {(
                  [
                    ["from", `${teamName} <${t("new.preview.user")}@${previewDomain}>`],
                    ["to", userEmail],
                    ["mailedBy", `${returnPath || "send"}.${previewDomain}`],
                    ["signedBy", previewDomain],
                    ["security", t("new.preview.details.securityValue")],
                  ] as const
                ).map(([key, value]) => (
                  <Fragment key={key}>
                    <span style={{ color: "var(--ms-muted)", textAlign: "right" }}>
                      {t(`new.preview.details.${key}`)}
                    </span>
                    <span style={{ color: "var(--ms-bone)", overflowWrap: "anywhere" }}>
                      {value}
                    </span>
                  </Fragment>
                ))}
              </div>
            ) : null}
            <div style={{ fontSize: 15, color: "var(--ms-bone)", fontWeight: 600, marginTop: 14 }}>
              {t("new.preview.subject")}
            </div>
            <div style={{ fontSize: 13, color: "var(--ms-muted)", marginTop: 4 }}>
              {t("new.preview.snippet")}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 10 }}>
            {t("new.preview.caption")}
          </div>
        </div>
      </div>
    </>
  );
}
