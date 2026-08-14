"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { formatRelative, formatUtcMinute, midTruncateParts } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { DomainStatusBadge } from "../domain-status";
import { RegionLabel } from "../region-label";
import { regionFlag } from "../regions";

const GROUPS = ["verification", "sending", "dmarc"] as const;

type RecordRow = {
  group: (typeof GROUPS)[number];
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
};

/** Mid-truncation with the dim […] token preserving both ends of the value. */
function MidTruncated({ value }: { value: string }) {
  const parts = midTruncateParts(value);
  if (!parts) return <>{value}</>;
  return (
    <>
      {parts.head}
      <span style={{ color: "var(--ms-faint)" }}>[…]</span>
      {parts.tail}
    </>
  );
}

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

function RecordsGroup({
  group,
  records,
}: {
  group: (typeof GROUPS)[number];
  records: RecordRow[];
}) {
  const t = useTranslations("domains");
  return (
    <div style={{ maxWidth: 1000 }}>
      <p className="ms-microlabel" style={{ margin: "0 0 10px" }}>
        {t(`detail.groups.${group}`)}
      </p>
      {/* Fully monospace — headers included — at the canvas's 12.5px. */}
      <Table className="ms-mono" style={{ fontSize: 12.5 }}>
        <thead>
          <tr className="ms-mono">
            <th>{t("detail.columns.type")}</th>
            <th>{t("detail.columns.name")}</th>
            <th>{t("detail.columns.value")}</th>
            <th>{t("detail.columns.ttl")}</th>
            <th>{t("detail.columns.priority")}</th>
            <th>{t("detail.columns.status")}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={`${record.type}-${record.name}-${record.value}`}>
              <td style={{ width: 70 }}>{record.type}</td>
              <td style={{ width: 230 }}>
                <MidTruncated value={record.name} />
                <CopyGlyph value={record.name} />
              </td>
              <td>
                <MidTruncated value={record.value} />
                <CopyGlyph value={record.value} />
              </td>
              <td style={{ width: 60 }}>{t("detail.ttlAuto")}</td>
              <td style={{ width: 64 }}>{record.priority ?? "—"}</td>
              <td style={{ width: 96 }}>
                {record.status ? <DomainStatusBadge status={record.status} /> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
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
    return <div className="ms-card" style={{ height: 220, background: "var(--ms-panel)" }} />;
  }

  const data = domain.data;
  const provider = records.data?.provider ?? null;
  const rows = (records.data?.records ?? []) as RecordRow[];
  const checkable = rows.filter((r) => r.status !== null);
  const foundCount = checkable.filter((r) => r.status === "verified").length;

  const sublineParts = [
    status === "verified" && data.verifiedAt
      ? t("detail.subline.verified", { time: formatRelative(data.verifiedAt, locale) })
      : t("detail.subline.added", { time: formatRelative(data.createdAt, locale) }),
    `${regionFlag(data.region)} ${data.region}`,
    ...(provider
      ? [
          status === "verified"
            ? provider.name
            : t("detail.subline.provider", { name: provider.name }),
        ]
      : []),
    ...(status === "verified"
      ? [t("detail.subline.sent", { count: data.sentCount })]
      : checkable.length > 0
        ? [t("detail.subline.recordsFound", { found: foundCount, total: checkable.length })]
        : []),
  ];

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
        subtitle={sublineParts.join(" · ")}
        breadcrumb={
          <>
            <Crumb href="/domains" label={nav("domains")} />
            <CrumbEnd label={t("detail.eyebrow")} />
          </>
        }
        actions={
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
                    window.open(`${base}${encodeURIComponent(aiPrompt())}`, "_blank", "noreferrer");
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
        }
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          maxWidth: 1000,
        }}
      >
        <MetaItem label={t("detail.created")}>{formatUtcMinute(data.createdAt)}</MetaItem>
        <MetaItem label={t("detail.status")}>
          <DomainStatusBadge status={status} />
        </MetaItem>
        <MetaItem label={t("detail.providerLabel")}>
          {provider ? (
            <span
              style={{
                textDecoration: "underline dotted var(--ms-faint)",
                textUnderlineOffset: 3,
              }}
            >
              {provider.name}
            </span>
          ) : (
            "—"
          )}
        </MetaItem>
        <MetaItem label={t("detail.region")}>
          <RegionLabel region={data.region} variant="meta" />
        </MetaItem>
      </div>

      {checking ? (
        <GradientBanner variant="warn">
          <span className="ms-spinner" />
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
        ) : records.isSuccess ? (
          <div style={{ display: "grid", gap: 20, marginTop: 22 }}>
            {GROUPS.map((group) => (
              <RecordsGroup
                key={group}
                group={group}
                records={rows.filter((r) => r.group === group)}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              height: 120,
              marginTop: 22,
              borderRadius: "var(--ms-r-input)",
              background: "var(--ms-inset)",
            }}
          />
        )}

        {status !== "verified" ? (
          <div
            className="ms-wrap-row"
            style={{ display: "flex", gap: 10, marginTop: 24, alignItems: "center" }}
          >
            {provider?.url ? (
              <a
                className="ms-btn ms-btn-secondary"
                style={{ textDecoration: "none" }}
                href={provider.url}
                target="_blank"
                rel="noreferrer"
              >
                {t("detail.goToProvider", { provider: provider.name })} ↗
              </a>
            ) : null}
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={verify.isPending}
              onClick={() => verify.mutate({ id })}
            >
              <BtnSpinner on={verify.isPending} />
              {t("detail.verify")}
            </button>
            <span
              className="ms-mono"
              style={{ fontSize: 12, color: "var(--ms-muted)", marginLeft: "auto" }}
            >
              {t("detail.honestNote")}
            </span>
          </div>
        ) : null}
      </section>

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
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
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
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
        </div>
      </Modal>
    </>
  );
}
