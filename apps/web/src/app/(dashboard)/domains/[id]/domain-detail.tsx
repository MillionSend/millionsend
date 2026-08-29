"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import {
  type DnsRecord,
  DnsRecordsTable,
  DnsRecordsTableSkeleton,
} from "@/components/dns-records-table";
import { MetaItem } from "@/components/meta-item";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner, Spinner } from "@/components/spinner";
import { Switch } from "@/components/switch";
import { WarnCard } from "@/components/warn-card";
import { formatRelative, formatUtcMinute } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { isLoopbackUrl } from "@/lib/url";
import { DomainStatusBadge } from "../domain-status";
import { RegionLabel } from "../region-label";

// Single lowercase DNS label — mirrors SUBDOMAIN_RE the domains router enforces.
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Status-tinted gradient banner (canvas: near-black ground, glow rising from
 * the left edge). The rgba glows are the canvas values verbatim — the token
 * palette only carries their hex bases.
 */
function GradientBanner({
  variant,
  children,
}: {
  variant: "success" | "warn";
  children: React.ReactNode;
}) {
  const glow = statusGlow(variant, variant === "success" ? 15 : 14);
  return (
    <div
      role="status"
      className="ms-wrap-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        backgroundColor: "var(--ms-ground)",
        backgroundImage: glow,
        border: `1px solid var(--ms-${variant}-border)`,
        borderRadius: 12,
        padding: "11px 16px",
        marginTop: 24,
        maxWidth: 1000,
      }}
    >
      {children}
    </div>
  );
}

/** Party-popper (Lucide, MIT) — the celebratory mark on the verified banner. */
function TadaIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ms-success)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M5.8 11.3 2 22l10.7-3.79" />
      <path d="M4 3h.01" />
      <path d="M22 8h.01" />
      <path d="M15 2h.01" />
      <path d="M22 20h.01" />
      <path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" />
      <path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11-.11.7-.72 1.22-1.43 1.22H14" />
      <path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7" />
      <path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" />
    </svg>
  );
}

function ConfigSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ paddingTop: 22, marginTop: 22, borderTop: "1px solid var(--ms-line)" }}>
      <h3 style={{ fontSize: 14, fontWeight: 500, color: "var(--ms-bone)", margin: 0 }}>{title}</h3>
      {description ? (
        <p style={{ fontSize: 12.5, color: "var(--ms-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
          {description}
        </p>
      ) : null}
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

/**
 * Configuration preferences persist to the domain row. Engagement tracking is
 * app-layer: the open/click toggles decide whether WE rewrite links and inject
 * the open pixel at send time (SES is never asked to track). TLS remains a real
 * per-domain SES configuration-set setting. Toggles and TLS save on change; the
 * tracking subdomain saves on the explicit Update button so its branded CNAME
 * can be surfaced in the DNS table once set.
 */
function ConfigurationPanel({
  id,
  openTracking,
  clickTracking,
  trackingSubdomain,
  tlsMode,
  trackingCnameLive,
  trackingHostLocal,
  subdomainsSupported,
  trackingRequiresSubdomain,
  onShowTrackingRecords,
}: {
  id: string;
  openTracking: boolean;
  clickTracking: boolean;
  trackingSubdomain: string | null;
  tlsMode: "opportunistic" | "enforced";
  /** Live DNS verdict for the branded-tracking CNAME, once a check ran. */
  trackingCnameLive: string | undefined;
  /** APP_BASE_URL is loopback: recipients can never reach tracking URLs. */
  trackingHostLocal: boolean;
  /** This deployment can serve a customer hostname CNAME'd at the app. */
  subdomainsSupported: boolean;
  /** Cloud: without a tracking subdomain, links ship untracked — never via the shared host. */
  trackingRequiresSubdomain: boolean;
  onShowTrackingRecords: () => void;
}) {
  const t = useTranslations("domains");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [subdomain, setSubdomain] = useState(trackingSubdomain ?? "");

  const update = useMutation(
    trpc.domains.updateConfiguration.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
      },
    }),
  );

  const trimmed = subdomain.trim();
  const invalid = trimmed !== "" && !DNS_LABEL_RE.test(trimmed);
  const dirty = trimmed !== (trackingSubdomain ?? "");

  function saveSubdomain() {
    if (invalid || !dirty) return;
    update.mutate({ id, trackingSubdomain: trimmed });
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
        {t("detail.configuration.note")}
      </div>

      {/* A stored subdomain keeps the section even where the deployment cannot
          serve it: this input is the only way to clear one, and both write
          paths deliberately still accept a clear. */}
      {subdomainsSupported || trackingSubdomain !== null ? (
        <ConfigSection
          title={t("detail.configuration.trackingMetrics")}
          description={t("detail.tracking.subdomainHint")}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", maxWidth: 460 }}>
            <div className="ms-field" style={{ flex: 1 }}>
              <input
                id="tracking-subdomain"
                type="text"
                className="ms-input mono"
                style={{ width: "100%" }}
                aria-label={t("detail.tracking.subdomain")}
                placeholder={t("detail.tracking.subdomainPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                disabled={update.isPending}
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveSubdomain();
                }}
              />
            </div>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={update.isPending || invalid || !dirty}
              onClick={saveSubdomain}
            >
              {t("detail.configuration.update")}
            </button>
          </div>
          {(() => {
            // The subdomain only works once its CNAME resolves; until then a
            // warn card leads straight to the record.
            const cnameMissing = trackingSubdomain !== null && trackingCnameLive !== "found";
            if (invalid) {
              return (
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ms-danger)" }}>
                  {t("detail.tracking.subdomainError")}
                </p>
              );
            }
            if (!subdomainsSupported) {
              return <WarnCard>{t("detail.tracking.subdomainUnavailable")}</WarnCard>;
            }
            if (cnameMissing) {
              return (
                <WarnCard
                  action={
                    <button
                      type="button"
                      className="ms-btn ms-btn-secondary"
                      onClick={onShowTrackingRecords}
                    >
                      {t("detail.configuration.viewDnsRecord")}
                    </button>
                  }
                >
                  {t("detail.configuration.subdomainDnsMissing")}
                </WarnCard>
              );
            }
            return (
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 12,
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  color: "var(--ms-muted)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: trackingSubdomain ? "var(--ms-success)" : "var(--ms-faint)",
                  }}
                />
                {trackingSubdomain
                  ? t("detail.configuration.subdomainActive")
                  : t("detail.configuration.subdomainNeutral")}
              </p>
            );
          })()}
        </ConfigSection>
      ) : null}

      {trackingHostLocal ? <WarnCard>{t("detail.tracking.localWarning")}</WarnCard> : null}

      {trackingRequiresSubdomain && !trackingSubdomain ? (
        <WarnCard>{t("detail.tracking.cloudRequiresSubdomain")}</WarnCard>
      ) : null}

      <ConfigSection
        title={t("detail.tracking.click")}
        description={t("detail.tracking.clickHint")}
      >
        <Switch
          checked={clickTracking}
          disabled={update.isPending || trackingHostLocal}
          onChange={(checked) => update.mutate({ id, clickTracking: checked })}
          ariaLabel={t("detail.tracking.click")}
        />
      </ConfigSection>

      <ConfigSection title={t("detail.tracking.open")} description={t("detail.tracking.openHint")}>
        <Switch
          checked={openTracking}
          disabled={update.isPending || trackingHostLocal}
          onChange={(checked) => update.mutate({ id, openTracking: checked })}
          ariaLabel={t("detail.tracking.open")}
        />
      </ConfigSection>

      <ConfigSection
        title={t("detail.configuration.tls")}
        description={t("detail.configuration.tlsHint")}
      >
        <Select
          value={tlsMode}
          ariaLabel={t("detail.configuration.tls")}
          disabled={update.isPending}
          width={240}
          onChange={(value) =>
            update.mutate({ id, tlsMode: value as "opportunistic" | "enforced" })
          }
          options={[
            { value: "opportunistic", label: t("detail.configuration.tlsOpportunistic") },
            { value: "enforced", label: t("detail.configuration.tlsEnforced") },
          ]}
        />
      </ConfigSection>
    </div>
  );
}

export function DomainDetail({ id }: { id: string }) {
  const t = useTranslations("domains");
  const nav = useTranslations("nav");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const domain = useQuery(trpc.domains.get.queryOptions({ id }));
  const records = useQuery(
    trpc.domains.records.queryOptions({ id }, { enabled: domain.isSuccess }),
  );

  // Persist the last live-DNS result across re-checks. Reading it straight off
  // the verify mutation would blank out while a re-check is pending, so a row
  // whose live status is Missing would flick back to AWS's cached Verified for
  // that instant. Holding the previous result keeps the badge stable.
  const [liveDns, setLiveDns] = useState<
    { type: string; name: string; value: string; status: "found" | "missing" | "mismatch" }[]
  >([]);
  // Set when the Configuration tab sends the user to the tracking CNAME:
  // switches to Records, pulses that group once, then clears itself.
  const [highlightTracking, setHighlightTracking] = useState(false);
  const sesEnv = useQuery(trpc.system.sesEnv.queryOptions());
  const trackingSubdomainsSupported = sesEnv.data?.trackingSubdomainsSupported ?? true;
  // The Records-tab header switch flips open+click together (one concept there;
  // Configuration keeps the granular toggles).
  const updateTracking = useMutation(
    trpc.domains.updateConfiguration.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
      },
    }),
  );

  const verify = useMutation(
    trpc.domains.verify.mutationOptions({
      onSuccess: (data) => {
        setLiveDns(data.liveDns ?? []);
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.list.queryKey() });
      },
    }),
  );
  const deleteDomain = useMutation(
    trpc.domains.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.domains.list.queryKey() });
        router.push("/domains");
      },
    }),
  );

  // A verify round-trip can return in well under a human blink; holding the
  // pending state for a floor keeps the Check DNS button's spinner visible so
  // the click registers as an action that ran.
  const [minSpin, setMinSpin] = useState(false);
  const [copiedKey, setCopiedKey] = useState<"instructions" | "prompt" | null>(null);
  const [tab, setTab] = useState<"records" | "configuration">("records");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  // Stable identity: Modal's focus effect depends on onClose, and a fresh
  // arrow per render would re-run it on every keystroke, stealing focus
  // from the type-to-confirm input.
  const closeDelete = useCallback(() => setConfirmingDelete(false), []);

  const status = verify.data?.status ?? domain.data?.status;
  const checking = status === "pending" || status === "temporary_failure";

  // Live DNS must be real on load: the SES status can still read 'verified' for
  // a record removed seconds ago, so re-check every record's live DNS on mount.
  const verifyMutate = verify.mutate;
  useEffect(() => {
    verifyMutate({ id });
  }, [id, verifyMutate]);

  // Canvas: "checks run every 30 s" — the page re-checks SES itself while pending.
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => verifyMutate({ id }), 30_000);
    return () => clearInterval(timer);
  }, [checking, id, verifyMutate]);

  const runCheck = useCallback(() => {
    setMinSpin(true);
    setTimeout(() => setMinSpin(false), 600);
    verifyMutate({ id });
  }, [id, verifyMutate]);

  // Shared by the delete button and the modal's ⌘↵ shortcut; guards mirror
  // the button's disabled state.
  const confirmMatches = confirmText === domain.data?.name;
  function confirmDelete() {
    if (confirmMatches && !deleteDomain.isPending) deleteDomain.mutate({ id });
  }

  if (domain.isError) {
    return (
      <div
        className="ms-card"
        style={{ padding: 24, display: "flex", gap: 14, alignItems: "center" }}
      >
        <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)" }}>{t("detail.error")}</p>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={() => domain.refetch()}>
          {t("detail.retry")}
        </button>
      </div>
    );
  }
  if (!domain.isSuccess || !status) {
    // Mirrors the loaded page's containers exactly (PageHeader breadcrumb +
    // H1, MetaItem strip, status banner, record tables) so nothing shifts
    // when data lands. Text lines are 1lh bars inside the real typography
    // wrappers; display:flex makes the wrapper's height the bar's height,
    // which equals the loaded single-line height.
    return (
      <>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
            <Skeleton width={140} height="1lh" />
          </div>
          <h1
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", margin: 0, display: "flex" }}
          >
            <Skeleton width={260} height="1lh" />
          </h1>
        </div>
        <div
          className="ms-meta-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 22,
            padding: "20px 0",
            borderTop: "1px solid var(--ms-line)",
            borderBottom: "1px solid var(--ms-line)",
            maxWidth: 1000,
          }}
        >
          {/* Labels are static — only the values wait on data. The badge ghost
              keeps the strip at the loaded height (the status badge is its
              tallest cell). */}
          <MetaItem label={t("detail.created")}>
            <Skeleton width={110} height={14} />
          </MetaItem>
          <MetaItem label={t("detail.status")}>
            <SkeletonBadge />
          </MetaItem>
          <MetaItem label={t("detail.region")}>
            <Skeleton width={140} height={14} />
          </MetaItem>
        </div>
        {/* Every non-failed status shows a GradientBanner here on load;
            reserving its box (13.5px line + 11px vertical padding + 1px
            border) keeps the records section from jumping when status
            arrives. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 13.5,
            padding: "11px 16px",
            marginTop: 24,
            border: "1px solid var(--ms-line)",
            borderRadius: 12,
            maxWidth: 1000,
          }}
        >
          <Skeleton width={280} height="1lh" />
        </div>
        {/* Records | Configuration tab bar (Configuration lands once verified). */}
        <div className="ms-tabs" style={{ marginTop: 26 }}>
          <Skeleton width={64} height={30} radius="var(--ms-r-input)" />
          <Skeleton width={96} height={30} radius="var(--ms-r-input)" />
        </div>
        <section style={{ marginTop: 24, maxWidth: 1000 }}>
          <DnsRecordsTableSkeleton showStatus />
        </section>
      </>
    );
  }

  const data = domain.data;
  const provider = records.data?.provider ?? null;
  // Live DNS statuses keyed by record identity, from the persisted result so a
  // re-check doesn't blank the badges mid-flight.
  const liveByKey = new Map(liveDns.map((r) => [`${r.type}\t${r.name}\t${r.value}`, r.status]));
  const rows = ((records.data?.records ?? []) as DnsRecord[]).map((r) => ({
    ...r,
    live: liveByKey.get(`${r.type}\t${r.name}\t${r.value}`),
  }));

  function recordsText(): string {
    return rows
      .map((r) =>
        [r.type, r.name, r.value, t("detail.ttlAuto"), r.priority ?? ""].join("\t").trimEnd(),
      )
      .join("\n");
  }
  function aiPrompt(): string {
    return t("detail.aiPrompt", { domain: data.name, records: recordsText() });
  }

  async function copyToClipboard(text: string, key: "instructions" | "prompt") {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1600);
  }

  return (
    <>
      <PageHeader
        title={data.name}
        breadcrumb={
          <>
            <Crumb href="/domains" label={nav("domains")} />
            <CrumbEnd label={t("detail.eyebrow")} />
          </>
        }
        actions={
          <>
            <button
              type="button"
              className={
                status !== "verified" ? "ms-btn ms-btn-primary" : "ms-btn ms-btn-secondary"
              }
              title={t("detail.checkDnsTooltip")}
              disabled={verify.isPending || minSpin}
              onClick={runCheck}
            >
              <BtnSpinner on={verify.isPending || minSpin} />
              {t("detail.checkDns")}
            </button>
            <div style={{ position: "relative" }}>
              <PopoverMenu
                boxed
                ariaLabel={t("detail.moreActions")}
                items={[
                  {
                    label: t("detail.forwardInstructions"),
                    onSelect: () => {
                      window.location.href = `mailto:?subject=${encodeURIComponent(
                        t("detail.forwardSubject", { domain: data.name }),
                      )}&body=${encodeURIComponent(recordsText())}`;
                    },
                  },
                  {
                    label: t("detail.copyInstructions"),
                    disabled: !records.isSuccess,
                    onSelect: () => void copyToClipboard(recordsText(), "instructions"),
                  },
                  {
                    label: t("detail.copyAsPrompt"),
                    disabled: !records.isSuccess,
                    onSelect: () => void copyToClipboard(aiPrompt(), "prompt"),
                  },
                  null,
                  ...(
                    [
                      ["openInCursor", "cursor://anysphere.cursor-deeplink/prompt?text="],
                      ["openInClaude", "https://claude.ai/new?q="],
                      ["openInChatgpt", "https://chatgpt.com/?q="],
                    ] as const
                  ).map(([key, base]) => ({
                    label: t(`detail.${key}`),
                    trailing: "↗",
                    onSelect: () => {
                      window.open(
                        `${base}${encodeURIComponent(aiPrompt())}`,
                        "_blank",
                        "noreferrer",
                      );
                    },
                  })),
                  null,
                  {
                    label: t("detail.deleteDomain"),
                    danger: true,
                    onSelect: () => {
                      setConfirmText("");
                      setConfirmingDelete(true);
                    },
                  },
                ]}
              />
              {copiedKey ? (
                <span
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: 0,
                    whiteSpace: "nowrap",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-label)",
                  }}
                >
                  ✓ {common("copied")}
                </span>
              ) : null}
            </div>
          </>
        }
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          maxWidth: 1000,
        }}
      >
        <MetaItem label={t("detail.created")}>
          <span title={formatUtcMinute(data.createdAt)}>
            {formatRelative(data.createdAt, locale)}
          </span>
        </MetaItem>
        <MetaItem label={t("detail.status")}>
          <DomainStatusBadge status={status} />
        </MetaItem>
        <MetaItem label={t("detail.region")}>
          <RegionLabel region={data.region} variant="meta" />
        </MetaItem>
      </div>

      {checking ? (
        <GradientBanner variant="warn">
          <Spinner size={16} />
          <span style={{ fontSize: 13.5, color: "var(--ms-warn)" }}>
            {t("detail.bannerLooking")}
          </span>
          <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
            {provider
              ? t("detail.bannerLookingBody", { provider: provider.name })
              : t("detail.bannerLookingBodyGeneric")}
          </span>
        </GradientBanner>
      ) : status === "verified" ? (
        <GradientBanner variant="success">
          <TadaIcon />
          <span style={{ fontSize: 13.5, color: "var(--ms-success)" }}>
            {t("detail.bannerVerified")}
          </span>
          <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
            {t("detail.bannerVerifiedBody")}
          </span>
        </GradientBanner>
      ) : null}

      {/* Configuration is SES-verified-only: an unverified domain can't send,
          so its tracking/TLS settings have nothing to apply to yet. */}
      {status === "verified" ? (
        <div className="ms-tabs" style={{ marginTop: 26 }}>
          <button
            type="button"
            className={tab === "records" ? "active" : ""}
            onClick={() => setTab("records")}
          >
            {t("detail.tabs.records")}
          </button>
          <button
            type="button"
            className={tab === "configuration" ? "active" : ""}
            onClick={() => setTab("configuration")}
          >
            {t("detail.tabs.configuration")}
          </button>
        </div>
      ) : null}

      {status === "verified" && tab === "configuration" ? (
        <div style={{ marginTop: 24 }}>
          <ConfigurationPanel
            id={id}
            openTracking={data.openTracking}
            clickTracking={data.clickTracking}
            trackingSubdomain={data.trackingSubdomain}
            tlsMode={data.tlsMode}
            trackingCnameLive={rows.find((r) => r.group === "tracking")?.live}
            trackingHostLocal={isLoopbackUrl(sesEnv.data?.appBaseUrl)}
            subdomainsSupported={trackingSubdomainsSupported}
            trackingRequiresSubdomain={sesEnv.data?.trackingRequiresSubdomain ?? false}
            onShowTrackingRecords={() => {
              setTab("records");
              setHighlightTracking(true);
              requestAnimationFrame(() => {
                document
                  .getElementById("dns-group-tracking")
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              });
              setTimeout(() => setHighlightTracking(false), 2400);
            }}
          />
        </div>
      ) : (
        <section style={{ marginTop: status === "verified" ? 24 : 26, maxWidth: 1000 }}>
          {status !== "verified" ? (
            <h2 className="ms-display" style={{ fontSize: 22, margin: 0, color: "var(--ms-bone)" }}>
              {provider
                ? t("detail.recordsHeading", { provider: provider.name })
                : t("detail.recordsHeadingGeneric")}
            </h2>
          ) : null}

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
                  records={rows}
                  domain={data.name}
                  showStatus
                  highlightGroup={highlightTracking ? "tracking" : null}
                  forceGroups={status === "verified" ? ["tracking"] : []}
                  groupExtras={
                    status === "verified"
                      ? {
                          tracking: (
                            <Switch
                              checked={data.clickTracking || data.openTracking}
                              disabled={
                                updateTracking.isPending || isLoopbackUrl(sesEnv.data?.appBaseUrl)
                              }
                              onChange={(checked) =>
                                updateTracking.mutate({
                                  id,
                                  clickTracking: checked,
                                  openTracking: checked,
                                })
                              }
                              ariaLabel={t("detail.tracking.headerToggle")}
                            />
                          ),
                        }
                      : {}
                  }
                  emptyNotes={{
                    tracking: t(
                      trackingSubdomainsSupported
                        ? "detail.groups.trackingNote"
                        : "detail.groups.trackingNoteDefaultOnly",
                    ),
                  }}
                />
              ) : (
                <DnsRecordsTableSkeleton showStatus />
              )}
            </div>
          )}

          {status !== "verified" && provider?.url ? (
            <div style={{ display: "flex", gap: 10, marginTop: 24, alignItems: "center" }}>
              <a
                className="ms-btn ms-btn-secondary"
                style={{ textDecoration: "none" }}
                href={provider.url}
                target="_blank"
                rel="noreferrer"
              >
                {t("detail.goToProvider", { provider: provider.name })} ↗
              </a>
            </div>
          ) : null}
        </section>
      )}

      <Modal
        open={confirmingDelete}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        title={t("detail.deleteDomain")}
      >
        <p
          style={{
            margin: "10px 0 14px",
            color: "var(--ms-muted)",
            fontSize: 13.5,
            lineHeight: 1.6,
          }}
        >
          {t("detail.deleteBody")}
        </p>
        <CopyChip value={data.name} />
        <div className="ms-field" style={{ marginTop: 14 }}>
          <label htmlFor="delete-confirm">{t("detail.deleteConfirmLabel")}</label>
          <input
            id="delete-confirm"
            type="text"
            className="ms-input mono"
            style={{ width: "100%" }}
            placeholder={data.name}
            autoComplete="off"
            spellCheck={false}
            disabled={deleteDomain.isPending}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
        </div>
        {deleteDomain.isError ? (
          <p
            style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}
          >
            {t("detail.deleteError")}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={!confirmMatches || deleteDomain.isPending}
            onClick={confirmDelete}
          >
            <BtnSpinner on={deleteDomain.isPending} />
            {t("detail.deleteDomain")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>
    </>
  );
}
