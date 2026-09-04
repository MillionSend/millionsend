"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResourceApiButton } from "@/components/api-sheet";
import { CopyChip } from "@/components/copy-chip";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvLink } from "@/components/export-csv-link";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { NavTile, TONE_COLOR } from "@/components/status-tile";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import { useUrlState } from "@/lib/url-state";
import { useTeamRole } from "@/lib/use-team-role";
import { ListFooter, StateCard } from "../emails/list-parts";
import { AwsCredentialsBanner } from "./aws-credentials-banner";
import {
  DOMAIN_TONE,
  type DomainStatus,
  DomainStatusBadge,
  displayDomainStatus,
} from "./domain-status";
import { RegionLabel } from "./region-label";

/** Mirrors the loaded rows: mono domain link, status badge, region label, relative time. */
function SkeletonRows() {
  const widths = [180, 120, 90];
  return (
    <tbody>
      {widths.map((width) => (
        <tr key={width}>
          <td>
            <Skeleton width={width} height={13} />
          </td>
          <td>
            <SkeletonBadge />
          </td>
          <td>
            <Skeleton width={140} />
          </td>
          <td className="right">
            <Skeleton width={48} />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

const shown = (d: { status: string; trackingPending: boolean }) =>
  displayDomainStatus(d.status as DomainStatus, d.trackingPending);

export function DomainsView() {
  const t = useTranslations("domains");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const domains = useQuery(trpc.domains.list.queryOptions());
  const role = useTeamRole();
  const canManage = role === "owner" || role === "admin";

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const deleteMutation = useMutation(
    trpc.domains.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        setConfirmText("");
        domains.refetch();
      },
    }),
  );
  // Check DNS from the row: the same verify pass as the detail header; the
  // menu stays open with a spinner on the item until the list refreshes.
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const verifyMutation = useMutation(
    trpc.domains.verify.mutationOptions({
      onSettled: () => {
        setCheckingId(null);
        domains.refetch();
      },
    }),
  );
  // Stable identity: Modal's focus effect depends on onClose.
  const closeDelete = useCallback(() => {
    setDeleteTarget(null);
    setConfirmText("");
  }, []);
  // Shared by form submit and the modal's ⌘↵ shortcut; guards mirror the
  // delete button's disabled state.
  function confirmDelete() {
    if (deleteTarget && confirmText === deleteTarget.name && !deleteMutation.isPending) {
      deleteMutation.mutate({ id: deleteTarget.id });
    }
  }

  const [search, setSearch] = useUrlState("q");
  const [statusParam, setStatus] = useUrlState("status", "all");
  const [regionParam, setRegion] = useUrlState("region", "all");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere on the page.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const rows = domains.data ?? [];
  const regions = useMemo(() => [...new Set(rows.map((d) => d.region))], [rows]);

  // URL params are untrusted: unknown values fall back to "all".
  const status = ["all", "verified", "partial", "pending", "failed"].includes(statusParam)
    ? statusParam
    : "all";
  const region = regionParam === "all" || regions.includes(regionParam) ? regionParam : "all";

  const filtered = rows.filter(
    (d) =>
      d.name.includes(search.trim().toLowerCase()) &&
      (status === "all" ||
        shown(d) === status ||
        (status === "pending" && d.status === "temporary_failure")) &&
      (region === "all" || d.region === region),
  );

  const summary = useMemo(() => {
    if (rows.length === 0) return undefined;
    const counts = { verified: 0, partial: 0, pending: 0, failed: 0 };
    for (const d of rows) {
      const s = shown(d);
      counts[s === "temporary_failure" ? "pending" : s] += 1;
    }
    const parts = (["verified", "partial", "pending", "failed"] as const)
      .filter((key) => counts[key] > 0)
      .map((key) => t(`list.summary.${key}`, { count: counts[key] }));
    parts.push(
      regions.length === 1 && regions[0]
        ? t("list.summary.allIn", { region: regions[0] })
        : t("list.summary.regions", { count: regions.length }),
    );
    return parts.join(" · ");
  }, [rows, regions, t]);

  return (
    <>
      <PageHeader
        title={t("list.title")}
        {...(summary ? { subtitle: summary } : {})}
        actions={
          <>
            {canManage ? <ExportCsvLink href="/export/domains" /> : null}
            <Link href="/domains/new" className="ms-btn ms-btn-primary">
              <PlusGlyph size={14} />
              {t("list.addDomain")}
            </Link>
            <ResourceApiButton resource="domains" />
          </>
        }
      />

      <AwsCredentialsBanner />

      {domains.isError ? (
        <div
          className="ms-card"
          style={{ padding: "24px", display: "flex", gap: 14, alignItems: "center" }}
        >
          <p style={{ margin: 0, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
            {t("list.error")}
          </p>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => domains.refetch()}
          >
            {t("list.retry")}
          </button>
        </div>
      ) : domains.isSuccess && rows.length === 0 ? (
        <EmptyState
          area="domains"
          headline={t("list.empty")}
          body={t("list.emptyBody")}
          cta={
            <Link href="/domains/new" className="ms-btn ms-btn-primary">
              <PlusGlyph />
              {t("list.addDomain")}
            </Link>
          }
        />
      ) : (
        <>
          <div
            className="ms-filter-row"
            style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
          >
            {/* Search stretches to fill the filter row; the selects keep fixed widths. */}
            <div style={{ flex: 1, minWidth: 160 }}>
              <input
                ref={searchRef}
                type="text"
                className="ms-input"
                style={{ width: "100%" }}
                placeholder={t("list.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select
              value={status}
              onChange={setStatus}
              ariaLabel={t("list.allStatuses")}
              options={[
                { value: "all", label: t("list.allStatuses") },
                ...(["verified", "partial", "pending", "failed"] as const).map((key) => ({
                  value: key,
                  label: common(`status.${key}`),
                })),
              ]}
            />
            <Select
              value={region}
              onChange={setRegion}
              ariaLabel={t("list.allRegions")}
              options={[
                { value: "all", label: t("list.allRegions") },
                ...regions.map((code) => ({ value: code, label: code })),
              ]}
            />
          </div>

          {domains.isSuccess && filtered.length === 0 ? (
            <StateCard
              headline={t("list.noMatch")}
              actionLabel={t("list.clearFilters")}
              onAction={() => {
                setSearch("");
                setStatus("all");
                setRegion("all");
              }}
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <th style={{ width: "36%" }}>{t("list.columns.domain")}</th>
                    <th style={{ width: "15%" }}>{t("list.columns.status")}</th>
                    <th>{t("list.columns.region")}</th>
                    <th className="right" style={{ width: "13%" }}>
                      {t("list.columns.created")}
                    </th>
                  </tr>
                </thead>
                {domains.isPending ? (
                  <SkeletonRows />
                ) : (
                  <tbody>
                    {filtered.map((domain) => (
                      <tr key={domain.id}>
                        <td className="ms-mono">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                            <NavTile
                              name="domains"
                              color={TONE_COLOR[DOMAIN_TONE[shown(domain)]]}
                            />
                            <Link href={`/domains/${domain.id}`}>{domain.name}</Link>
                          </span>
                        </td>
                        <td>
                          <DomainStatusBadge status={shown(domain)} />
                        </td>
                        <td style={{ color: "var(--ms-muted)" }}>
                          <RegionLabel region={domain.region} />
                        </td>
                        <td className="right">
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 10,
                              justifyContent: "flex-end",
                            }}
                          >
                            <RelativeTime date={domain.createdAt} />
                            <PopoverMenu
                              ariaLabel={t("detail.moreActions")}
                              items={[
                                {
                                  label: t("list.rowDetails"),
                                  onSelect: () => router.push(`/domains/${domain.id}`),
                                },
                                ...(domain.status !== "verified" && canManage
                                  ? [
                                      {
                                        label: t("detail.checkDns"),
                                        busy: checkingId === domain.id,
                                        keepOpen: true,
                                        onSelect: () => {
                                          setCheckingId(domain.id);
                                          verifyMutation.mutate({ id: domain.id });
                                        },
                                      },
                                    ]
                                  : []),
                                null,
                                {
                                  label: t("detail.deleteDomain"),
                                  danger: true,
                                  onSelect: () => {
                                    setConfirmText("");
                                    setDeleteTarget({ id: domain.id, name: domain.name });
                                  },
                                },
                              ]}
                            />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                )}
              </Table>
              {domains.isSuccess ? (
                <ListFooter
                  left={t("list.pageOf", { pages: 1, total: filtered.length })}
                  singlePage
                />
              ) : null}
            </>
          )}
        </>
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        onConfirm={confirmDelete}
        title={t("detail.deleteDomain")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmDelete();
          }}
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
          {deleteTarget ? <CopyChip value={deleteTarget.name} /> : null}
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="domain-delete-confirm">{t("detail.deleteConfirmLabel")}</label>
            <input
              id="domain-delete-confirm"
              type="text"
              className="ms-input mono"
              style={{ width: "100%" }}
              placeholder={deleteTarget?.name}
              autoComplete="off"
              spellCheck={false}
              disabled={deleteMutation.isPending}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </div>
          {deleteMutation.isError ? (
            <p
              style={{
                margin: "8px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("detail.deleteError")}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={confirmText !== deleteTarget?.name || deleteMutation.isPending}
            >
              <BtnSpinner on={deleteMutation.isPending} />
              {t("detail.deleteDomain")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
