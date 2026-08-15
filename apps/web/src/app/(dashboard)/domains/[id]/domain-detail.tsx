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
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner, Spinner } from "@/components/spinner";
import { formatRelative, formatUtcMinute } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
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

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
        {label}
      </p>
      <div style={{ marginTop: 4, fontSize: 14, color: "var(--ms-bone)" }}>{children}</div>
    </div>
  );
}

function TrackingToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <span>
        <span style={{ display: "block", fontSize: 13.5, color: "var(--ms-bone)" }}>{label}</span>
        <span style={{ display: "block", fontSize: 12, color: "var(--ms-muted)", marginTop: 2 }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

/**
 * Tracking preferences persist to the domain row as settings; SES tracking
 * itself is enabled at the configuration-set level, so these toggles do not
 * gate it on their own. Toggles save immediately; the subdomain saves on blur
 * so a branded CNAME can be surfaced in the DNS table once set.
 */
function TrackingSection({
  id,
  openTracking,
  clickTracking,
  trackingSubdomain,
}: {
  id: string;
  openTracking: boolean;
  clickTracking: boolean;
  trackingSubdomain: string | null;
}) {
  const t = useTranslations("domains");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [subdomain, setSubdomain] = useState(trackingSubdomain ?? "");

  const update = useMutation(
    trpc.domains.updateTracking.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
      },
    }),
  );

  const invalid = subdomain.trim() !== "" && !DNS_LABEL_RE.test(subdomain.trim());

  function saveSubdomain() {
    const next = subdomain.trim();
    if (invalid || next === (trackingSubdomain ?? "")) return;
    update.mutate({ id, trackingSubdomain: next });
  }

  return (
    <section style={{ marginTop: 34, maxWidth: 1000 }}>
      <h2
        className="ms-display"
        style={{ fontSize: 22, margin: 0, fontWeight: 500, color: "var(--ms-bone)" }}
      >
        {t("detail.tracking.title")}
      </h2>
      <div className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 6 }}>
        {t("detail.tracking.subtitle")}
      </div>

      <div style={{ display: "grid", gap: 14, marginTop: 20 }}>
        <TrackingToggle
          label={t("detail.tracking.open")}
          hint={t("detail.tracking.openHint")}
          checked={openTracking}
          disabled={update.isPending}
          onChange={(checked) => update.mutate({ id, openTracking: checked })}
        />
        <TrackingToggle
          label={t("detail.tracking.click")}
          hint={t("detail.tracking.clickHint")}
          checked={clickTracking}
          disabled={update.isPending}
          onChange={(checked) => update.mutate({ id, clickTracking: checked })}
        />
        <div className="ms-field" style={{ maxWidth: 360 }}>
          <label htmlFor="tracking-subdomain">{t("detail.tracking.subdomain")}</label>
          <input
            id="tracking-subdomain"
            type="text"
            className="ms-input mono"
            style={{ width: "100%" }}
            placeholder={t("detail.tracking.subdomainPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            disabled={update.isPending}
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            onBlur={saveSubdomain}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 12,
              color: invalid ? "var(--ms-danger)" : "var(--ms-muted)",
            }}
          >
            {invalid ? t("detail.tracking.subdomainError") : t("detail.tracking.subdomainHint")}
          </p>
        </div>
      </div>
    </section>
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

  const verify = useMutation(
    trpc.domains.verify.mutationOptions({
      onSuccess: () => {
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

  const [copiedKey, setCopiedKey] = useState<"instructions" | "prompt" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  // Stable identity: Modal's focus effect depends on onClose, and a fresh
  // arrow per render would re-run it on every keystroke, stealing focus
  // from the type-to-confirm input.
  const closeDelete = useCallback(() => setConfirmingDelete(false), []);

  const status = verify.data?.status ?? domain.data?.status;
  const checking = status === "pending" || status === "temporary_failure";

  // Canvas: "checks run every 30 s" — the page re-checks SES itself while pending.
  const verifyMutate = verify.mutate;
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => verifyMutate({ id }), 30_000);
    return () => clearInterval(timer);
  }, [checking, id, verifyMutate]);

  // ⌘↵ confirms the type-to-confirm delete, as printed on the button.
  const confirmMatches = confirmText === domain.data?.name;
  useEffect(() => {
    if (!confirmingDelete) return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && confirmMatches) {
        deleteDomain.mutate({ id });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

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
        <section style={{ marginTop: 26, maxWidth: 1000 }}>
          <h2 className="ms-display" style={{ fontSize: 22, margin: 0, display: "flex" }}>
            <Skeleton width={300} height="1lh" />
          </h2>
          <div style={{ marginTop: 22 }}>
            <DnsRecordsTableSkeleton showStatus />
          </div>
        </section>
        <section style={{ marginTop: 34, maxWidth: 1000 }}>
          <h2 className="ms-display" style={{ fontSize: 22, margin: 0, display: "flex" }}>
            <Skeleton width={140} height="1lh" />
          </h2>
          <div style={{ display: "grid", gap: 14, marginTop: 20 }}>
            {[0, 1].map((toggle) => (
              <div key={toggle} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Skeleton width={13} height={13} />
                <div style={{ display: "grid", gap: 6 }}>
                  <Skeleton width={120} height="1lh" />
                  <Skeleton width={220} height="1lh" />
                </div>
              </div>
            ))}
            <div className="ms-field" style={{ maxWidth: 360 }}>
              <div style={{ display: "flex" }}>
                <Skeleton width={130} height="1lh" />
              </div>
              <div style={{ marginTop: 6, display: "flex" }}>
                <Skeleton width="100%" height={38} radius="var(--ms-r-input)" />
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  const data = domain.data;
  const provider = records.data?.provider ?? null;
  const rows = (records.data?.records ?? []) as DnsRecord[];
  const checkable = rows.filter((r) => r.status !== null);
  const foundCount = checkable.filter((r) => r.status === "verified").length;

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
            {status !== "verified" ? (
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={verify.isPending}
                onClick={() => verify.mutate({ id })}
              >
                <BtnSpinner on={verify.isPending} />
                {t("detail.verify")}
              </button>
            ) : null}
            <div style={{ position: "relative" }}>
              <PopoverMenu
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
          <span style={{ fontSize: 13.5, color: "var(--ms-success)" }}>
            {t("detail.bannerVerified")}
          </span>
          <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
            {t("detail.bannerVerifiedBody")}
          </span>
          {checkable.length > 0 ? (
            <span
              className="ms-mono"
              style={{ fontSize: 11, color: "var(--ms-muted)", marginLeft: "auto" }}
            >
              {t("detail.recordsCount", { found: foundCount, total: checkable.length })}
            </span>
          ) : null}
        </GradientBanner>
      ) : null}

      <section style={{ marginTop: 26, maxWidth: 1000 }}>
        <h2
          className="ms-display"
          style={{ fontSize: 22, margin: 0, fontWeight: 500, color: "var(--ms-bone)" }}
        >
          {status === "verified"
            ? t("detail.dnsTitle")
            : provider
              ? t("detail.recordsHeading", { provider: provider.name })
              : t("detail.recordsHeadingGeneric")}
        </h2>
        {status !== "verified" ? (
          <div className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 6 }}>
            {provider ? t("detail.recordsSublineProvider") : t("detail.recordsSubline")}
          </div>
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
              <DnsRecordsTable records={rows} domain={data.name} showStatus />
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

      <TrackingSection
        id={id}
        openTracking={data.openTracking}
        clickTracking={data.clickTracking}
        trackingSubdomain={data.trackingSubdomain}
      />

      <Modal open={confirmingDelete} onClose={closeDelete} title={t("detail.deleteDomain")}>
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
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={!confirmMatches || deleteDomain.isPending}
            onClick={() => deleteDomain.mutate({ id })}
          >
            <BtnSpinner on={deleteDomain.isPending} />
            {t("detail.deleteDomain")} <span className="ms-keycap">⌘</span>
            <span className="ms-keycap">↵</span>
          </button>
        </ModalFooter>
      </Modal>
    </>
  );
}
