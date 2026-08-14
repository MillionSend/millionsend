"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { DomainStatusBadge } from "../domain-status";

type DnsRecordRow = {
  group: "verification" | "sending" | "dmarc";
  type: string;
  name: string;
  value: string;
  priority?: number;
};

const GROUPS = ["verification", "sending", "dmarc"] as const;

/** Visual truncation only — the CopyChip always carries the full value. */
function midTruncate(value: string, max = 32): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 3) / 2);
  return `${value.slice(0, keep)}[…]${value.slice(-keep)}`;
}

function Banner({ variant, text }: { variant: "success" | "warn"; text: string }) {
  return (
    <p
      role="status"
      style={{
        margin: "20px 0 0",
        padding: "12px 16px",
        borderRadius: "var(--ms-r-input)",
        border: `1px solid var(--ms-${variant}-border)`,
        background: `var(--ms-${variant}-bg)`,
        color: `var(--ms-${variant})`,
        fontSize: "var(--ms-fs-ui)",
      }}
    >
      {text}
    </p>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="ms-microlabel" style={{ margin: 0 }}>
        {label}
      </p>
      <div style={{ marginTop: 6, fontSize: "var(--ms-fs-ui)", color: "var(--ms-bone)" }}>
        {children}
      </div>
    </div>
  );
}

function RecordsGroup({
  group,
  records,
}: {
  group: (typeof GROUPS)[number];
  records: DnsRecordRow[];
}) {
  const t = useTranslations("domains");
  const withPriority = group === "sending";
  return (
    <div>
      <p className="ms-microlabel" style={{ margin: "0 0 10px" }}>
        {t(`detail.groups.${group}`)}
      </p>
      {/* Fully monospace, headers included. */}
      <div className="ms-mono">
        <Table>
          <thead>
            <tr>
              <th>{t("detail.columns.type")}</th>
              <th>{t("detail.columns.name")}</th>
              <th>{t("detail.columns.value")}</th>
              <th>{t("detail.columns.ttl")}</th>
              {withPriority ? <th>{t("detail.columns.priority")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={`${record.type}-${record.name}-${record.value}`}>
                <td>{record.type}</td>
                <td>
                  <CopyChip value={record.name} display={midTruncate(record.name)} />
                </td>
                <td>
                  <CopyChip value={record.value} display={midTruncate(record.value)} />
                </td>
                <td>{t("detail.ttlAuto")}</td>
                {withPriority ? <td>{record.priority ?? "—"}</td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

export function DomainDetail({ id }: { id: string }) {
  const t = useTranslations("domains");
  const common = useTranslations("common");
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

  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedInstructions, setCopiedInstructions] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
  if (!domain.isSuccess) {
    return <div className="ms-card" style={{ height: 220, background: "var(--ms-panel)" }} />;
  }

  const data = domain.data;
  const status = verify.data?.status ?? data.status;
  const showPendingBanner =
    verify.isSuccess && (status === "pending" || status === "temporary_failure");

  async function copyInstructions() {
    const rows = records.data?.records ?? [];
    const text = rows
      .map((r) => [r.type, r.name, r.value, "Auto", r.priority ?? ""].join("\t").trimEnd())
      .join("\n");
    await navigator.clipboard.writeText(text);
    setMenuOpen(false);
    setCopiedInstructions(true);
    setTimeout(() => setCopiedInstructions(false), 1600);
  }

  return (
    <>
      <header style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div>
            <p className="ms-microlabel" style={{ margin: 0 }}>
              {t("detail.eyebrow")}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6 }}>
              <h1
                className="ms-display"
                style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", margin: 0 }}
              >
                {data.name}
              </h1>
              <DomainStatusBadge status={status} />
            </div>
          </div>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            {t("detail.deleteDomain")}
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 48,
            padding: "16px 0",
            marginTop: 20,
            borderTop: "1px solid var(--ms-line)",
            borderBottom: "1px solid var(--ms-line)",
          }}
        >
          <MetaItem label={t("detail.created")}>
            <RelativeTime date={data.createdAt} />
          </MetaItem>
          <MetaItem label={t("detail.status")}>
            <DomainStatusBadge status={status} />
          </MetaItem>
          <MetaItem label={t("detail.region")}>
            <span className="ms-mono">{data.region}</span>
          </MetaItem>
        </div>
      </header>

      <section className="ms-card" style={{ padding: 24 }}>
        <h2
          style={{
            margin: "0 0 20px",
            fontSize: "var(--ms-fs-section)",
            fontWeight: 600,
            color: "var(--ms-bone)",
          }}
        >
          {t("detail.dnsTitle")}
        </h2>

        {records.isError ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
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
          <div style={{ display: "grid", gap: 24 }}>
            {GROUPS.map((group) => (
              <RecordsGroup
                key={group}
                group={group}
                records={records.data.records.filter((r) => r.group === group)}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              height: 120,
              borderRadius: "var(--ms-r-input)",
              background: "var(--ms-inset)",
            }}
          />
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 24 }}>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={verify.isPending}
            onClick={() => verify.mutate({ id })}
          >
            {t("detail.verify")}
          </button>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="ms-btn ms-btn-icon"
              aria-label={t("detail.moreActions")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              …
            </button>
            {menuOpen ? (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  minWidth: 200,
                  padding: 6,
                  background: "var(--ms-panel)",
                  border: "1px solid var(--ms-line-strong)",
                  borderRadius: "var(--ms-r-input)",
                  zIndex: 10,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="ms-btn ms-btn-ghost"
                  style={{ width: "100%", justifyContent: "flex-start" }}
                  disabled={!records.isSuccess}
                  onClick={copyInstructions}
                >
                  {t("detail.copyInstructions")}
                </button>
              </div>
            ) : null}
          </div>
          {copiedInstructions ? (
            <span style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
              ✓ {common("copied")}
            </span>
          ) : null}
        </div>

        {status === "verified" ? (
          <Banner variant="success" text={t("detail.bannerVerified")} />
        ) : showPendingBanner ? (
          <Banner variant="warn" text={t("detail.bannerPending")} />
        ) : null}
      </section>

      <Modal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={t("detail.deleteDomain")}
      >
        <p style={{ margin: "0 0 20px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("detail.deleteBody", { domain: data.name })}
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => setConfirmingDelete(false)}
          >
            {common("cancel")}
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={deleteDomain.isPending}
            onClick={() => deleteDomain.mutate({ id })}
          >
            {t("detail.deleteDomain")}
          </button>
        </div>
      </Modal>
    </>
  );
}
