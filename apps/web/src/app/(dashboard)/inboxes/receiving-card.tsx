"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CopyButton } from "@/components/copy-chip";
import { DnsRecordCard, InsetCard } from "@/components/dns-record-card";
import { BtnSpinner, Spinner } from "@/components/spinner";
import { WarnCard } from "@/components/warn-card";
import { RECEIVING_DOCS_URL } from "@/lib/docs-links";
import {
  domainReceivingHref,
  lowestMxHost,
  receivingErrorKey,
  receivingStep,
} from "@/lib/receiving-setup";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { absoluteUrl } from "@/lib/url";
import { useMinSpin } from "@/lib/use-min-spin";
import { isTeamAdmin, useTeamRole } from "@/lib/use-team-role";
import { receivingSubdomain } from "@/lib/zone";
import type { DomainStatus } from "../domains/domain-status";

const TITLE = { fontSize: 13, fontWeight: 500, color: "var(--ms-bone)" } as const;
const BODY = { margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.55, color: "var(--ms-muted)" };
const ACTIONS = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 12,
} as const;

/**
 * What the picked domain still needs before an inbox on it gets mail, said
 * under the Address field, with the safe part done right there: receiving is
 * offered only when DNS shows no other mail server for the domain, and its MX
 * record shows before anyone wonders why no mail arrives. Nothing shows for a
 * domain that already receives here.
 */
export function ReceivingCard({
  domain,
  sharedDomain,
  subdomainTaken,
}: {
  domain: { id: string; name: string; status: DomainStatus; receiving: boolean };
  sharedDomain: string | null;
  /** The team already has the subdomain a warning would suggest adding. */
  subdomainTaken: boolean;
}) {
  const t = useTranslations("inboxes");
  const td = useTranslations("domains");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const admin = isTeamAdmin(useTeamRole());
  const verified = domain.status === "verified";
  const mx = useQuery(
    trpc.domains.receivingMx.queryOptions(
      { id: domain.id },
      { enabled: verified, staleTime: 30_000 },
    ),
  );
  const [acted, setActed] = useState(false);
  const [spinning, spin] = useMinSpin();
  const enable = useMutation(
    trpc.domains.setReceiving.mutationOptions({
      onSuccess: () => {
        setActed(true);
        // The pick joins the receiving domains; its page and MX check follow.
        void queryClient.invalidateQueries(trpc.inboxes.options.pathFilter());
        void queryClient.invalidateQueries(trpc.domains.pathFilter());
      },
    }),
  );
  // On from the moment the switch answers, not once the options refetch.
  const receiving = domain.receiving || enable.isSuccess;
  const step = receivingStep({ verified, receiving, mx: mx.data?.status, acted });
  if (step === null) return null;

  const name = domain.name;
  const record = mx.data?.record;
  const until = sharedDomain
    ? ` ${t("create.receiving.untilShared", { domain: sharedDomain })}`
    : "";
  const docs = (
    <a
      className="ms-link"
      href={RECEIVING_DOCS_URL}
      target="_blank"
      rel="noreferrer"
      style={{ fontSize: 12.5, color: "var(--ms-muted)" }}
    >
      {t("create.receiving.docs")} ↗
    </a>
  );
  const checking = mx.isFetching || spinning;
  const checkDns = (
    <button
      type="button"
      className="ms-btn ms-btn-secondary"
      disabled={checking}
      // Takes the focus the Enable button had when the record replaces it.
      // biome-ignore lint/a11y/noAutofocus: focus follows the action the user just took
      autoFocus={enable.isSuccess}
      onClick={() => {
        spin();
        setActed(true);
        void mx.refetch();
      }}
    >
      <BtnSpinner on={checking} />
      {td("detail.checkDns")}
    </button>
  );
  const offTitle = <div style={TITLE}>{t("create.receiving.offTitle", { domain: name })}</div>;

  let card: React.ReactNode;
  if (step === "unverified") {
    card = (
      <InsetCard>
        <div style={TITLE}>{t("create.receiving.unverifiedTitle", { domain: name })}</div>
        <p style={BODY}>{t("create.receiving.unverifiedBody")}</p>
        <div style={ACTIONS}>
          <Link href={`/domains/${domain.id}`} className="ms-btn ms-btn-secondary">
            {t("create.receiving.openDomain")}
          </Link>
        </div>
      </InsetCard>
    );
  } else if (step === "checking") {
    card = (
      <InsetCard>
        {offTitle}
        <p style={{ ...BODY, display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner />
          {t("create.receiving.checking", { domain: name })}
        </p>
      </InsetCard>
    );
  } else if (step === "enable") {
    card = (
      <InsetCard>
        {offTitle}
        <p style={BODY}>
          {admin
            ? t(
                mx.data?.status === "found"
                  ? "create.receiving.enableFound"
                  : "create.receiving.enableBody",
              )
            : `${t("create.receiving.memberBody")}${until}`}
        </p>
        <div style={ACTIONS}>
          {admin ? (
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={enable.isPending}
              onClick={() => enable.mutate({ id: domain.id, enabled: true })}
            >
              <BtnSpinner on={enable.isPending} />
              {td("detail.receiving.enable")}
            </button>
          ) : (
            <CopyButton
              value={absoluteUrl(domainReceivingHref(domain.id))}
              label={t("create.receiving.copyLink")}
            />
          )}
          {docs}
        </div>
        {enable.error ? (
          <p className="ms-field-error">
            {td(receivingErrorKey(trpcErrorCode(enable.error)), { domain: name })}
          </p>
        ) : null}
      </InsetCard>
    );
  } else if (step === "elsewhere") {
    const sub = receivingSubdomain(name);
    card = (
      <>
        <WarnCard
          flush
          action={
            admin && !subdomainTaken ? (
              <Link
                href={`/domains/new?name=${encodeURIComponent(sub)}`}
                className="ms-btn ms-btn-secondary"
              >
                {t("create.receiving.addDomain", { domain: sub })}
              </Link>
            ) : undefined
          }
        >
          {td(receiving ? "detail.receiving.elsewhereOn" : "detail.receiving.elsewhereOff", {
            domain: name,
            host: lowestMxHost(mx.data?.found) ?? "",
            sub,
          })}
        </WarnCard>
        {receiving ? null : (
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
            {admin
              ? t.rich("create.receiving.onPurpose", {
                  domain: name,
                  link: (chunks) => (
                    <Link href={domainReceivingHref(domain.id)} className="ms-link">
                      {chunks}
                    </Link>
                  ),
                })
              : `${t("create.receiving.memberAddDomain")}${until}`}
          </p>
        )}
      </>
    );
  } else if (step === "unknown" && !receiving) {
    card = (
      <InsetCard>
        {offTitle}
        <p style={BODY}>{t("create.receiving.unknown", { domain: name })}</p>
        <div style={ACTIONS}>
          {checkDns}
          {docs}
        </div>
      </InsetCard>
    );
  } else if (record) {
    // On here: the record to add, live, or not answering yet.
    card = (
      <DnsRecordCard
        label={t("create.receiving.mxToAdd")}
        status={step === "live" ? "verified" : step === "add_mx" ? "missing" : "pending"}
        record={record}
        domain={name}
      >
        <p style={{ ...BODY, margin: "12px 0 0" }}>
          {step === "live"
            ? t("create.receiving.liveBody")
            : step === "add_mx"
              ? t("create.receiving.addMxBody")
              : t("create.receiving.unknown", { domain: name })}
        </p>
        <div style={ACTIONS}>
          {step === "live" ? null : checkDns}
          {docs}
        </div>
      </DnsRecordCard>
    );
  }
  return card ? (
    <div role="status" style={{ marginTop: 10 }}>
      {card}
    </div>
  ) : null;
}
