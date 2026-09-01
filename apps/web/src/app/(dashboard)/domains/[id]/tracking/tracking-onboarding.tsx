"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type DnsRecord, DnsRecordsTable } from "@/components/dns-records-table";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { MarkerRail, MobileStepBar } from "@/components/stepper";
import { useTRPC } from "@/lib/trpc";
import { TrackingSetup } from "../../tracking-setup";

/**
 * The branded-tracking onboarding, reached by toggling a tracking switch on (or
 * "change subdomain") from a domain's Configuration tab. Mirrors the add-domain
 * wizard: a Details step (subdomain + options + preview, via TrackingSetup) then
 * the DNS record to add and verify. The ?enable query pre-checks the kind whose
 * switch sent the user here.
 */
export function TrackingOnboarding({ id }: { id: string }) {
  const t = useTranslations("domains");
  const nav = useTranslations("nav");
  const router = useRouter();
  const trpc = useTRPC();
  const enable = useSearchParams().get("enable");
  const domain = useQuery(trpc.domains.get.queryOptions({ id }));
  const records = useQuery(trpc.domains.records.queryOptions({ id }));
  const [saved, setSaved] = useState(false);

  const trackingRow =
    (records.data?.records as DnsRecord[] | undefined)?.find((r) => r.group === "tracking") ?? null;
  // Step 01 is done once a subdomain exists (arrived via "change subdomain") or
  // has just been saved here; the DNS step opens then.
  const detailsDone = saved || Boolean(domain.data?.trackingSubdomain);

  return (
    <>
      <PageHeader
        title={t("trackingSetup.title")}
        subtitle={t("trackingSetup.subtitle")}
        breadcrumb={
          <>
            <Crumb href="/domains" label={nav("domains")} />
            {domain.data ? <Crumb href={`/domains/${id}`} label={domain.data.name} /> : null}
            <CrumbEnd label={t("trackingSetup.title")} />
          </>
        }
      />
      <div className="ms-step-col" style={{ display: "flex", flexDirection: "column" }}>
        <MobileStepBar
          steps={[t("trackingSetup.steps.details"), t("trackingSetup.steps.dns")]}
          active={detailsDone ? 2 : 1}
        />

        {/* Step 01 — Details */}
        <div className="ms-step" style={{ display: "flex", gap: 44 }}>
          <MarkerRail
            marker="01"
            done={detailsDone}
            fadeTop
            color={detailsDone ? "var(--ms-success)" : "var(--ms-bone)"}
          />
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 28 }}>
            <h2
              className="ms-display"
              style={{ fontSize: 22, margin: "0 0 6px", color: "var(--ms-bone)" }}
            >
              {t("trackingSetup.detailsTitle")}
            </h2>
            <p
              style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)", maxWidth: 520 }}
            >
              {t("trackingSetup.detailsSubtitle")}
            </p>
            {domain.isSuccess ? (
              <TrackingSetup
                heading={false}
                id={id}
                domainName={domain.data.name}
                mailFromSubdomain={domain.data.mailFromSubdomain}
                initialSubdomain={domain.data.trackingSubdomain}
                initialClick={domain.data.clickTracking || enable === "click"}
                initialOpen={domain.data.openTracking || enable === "open"}
                onSaved={() => setSaved(true)}
              />
            ) : (
              <Skeleton width={520} height={260} />
            )}
          </div>
        </div>

        {/* Step 02 — DNS record for the saved subdomain */}
        <div className="ms-step" style={{ display: "flex", gap: 44 }}>
          <MarkerRail marker="02" color="var(--ms-bone)" fadeBottom />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              className="ms-display"
              style={{ fontSize: 22, margin: "0 0 6px", color: "var(--ms-bone)" }}
            >
              {t("trackingSetup.dnsTitle")}
            </h2>
            <p
              style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)", maxWidth: 520 }}
            >
              {t("trackingSetup.dnsSubtitle")}
            </p>
            {detailsDone && trackingRow ? (
              <>
                <DnsRecordsTable records={[trackingRow]} domain={domain.data?.name} />
                <button
                  type="button"
                  className="ms-btn ms-btn-primary"
                  style={{ marginTop: 24 }}
                  onClick={() => router.push(`/domains/${id}`)}
                >
                  {t("trackingSetup.done")}
                </button>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>
                {t("trackingSetup.dnsPending")}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
