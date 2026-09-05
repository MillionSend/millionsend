"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ResourceApiButton } from "@/components/api-sheet";
import { ChipMultiSelect } from "@/components/chip-multi-select";
import { confirmDialog } from "@/components/confirm-dialog";
import { ContactAvatar } from "@/components/contact-avatar";
import { CopyChip } from "@/components/copy-chip";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvLink } from "@/components/export-csv-link";
import { GrowthSparkline } from "@/components/growth-sparkline";
import { ChevronGlyph, PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu, useDismiss } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatBlock } from "@/components/stat-block";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { CONTACT_STATUSES } from "@/lib/contact-status";
import { type CsvContactRow, parseCsvContacts } from "@/lib/csv";
import { MIGRATE_DOCS_URL } from "@/lib/docs-links";
import { formatDayUtc } from "@/lib/format";
import { migrateCommand } from "@/lib/migrate-command";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { useTeamRole } from "@/lib/use-team-role";
import { ListFooter, SearchBox, StateCard } from "../emails/list-parts";
import { AudienceTabs } from "./audience-tabs";

/** addMany's input ceiling — larger CSVs go up in sequential batches. */
const IMPORT_BATCH = 1000;

/** The bulk mutations' contactIds ceiling — larger selections go up in sequential batches. */
const BULK_BATCH = 100;

function ContactsHead({ selectAll }: { selectAll?: React.ReactNode }) {
  const t = useTranslations("audience");
  // The table runs fixed layout: column shares hold and long cells truncate
  // instead of pushing the trailing columns past the page edge.
  return (
    <thead>
      <tr>
        <th className="ms-check-cell">{selectAll}</th>
        <th style={{ width: "40%" }}>{t("contacts.email")}</th>
        <th style={{ width: "22%" }}>{t("contacts.segments")}</th>
        <th style={{ width: "15%" }}>{t("contacts.status")}</th>
        <th className="right">{t("contacts.added")}</th>
        <th className="right" style={{ width: 40 }} />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded contacts table: avatar + mono email, badge, time, action trigger. */
function ContactsSkeleton() {
  const widths = ["58%", "42%", "66%", "50%", "38%"];
  return (
    <Table gutter={28} style={{ tableLayout: "fixed" }}>
      <ContactsHead />
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td className="ms-check-cell" />
            <td>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Skeleton width={24} height={24} radius="50%" />
                <Skeleton width={width} height={13} />
              </span>
            </td>
            <td>
              <Skeleton width={70} />
            </td>
            <td>
              <SkeletonBadge width={82} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
            <td className="right" style={{ width: 40 }}>
              <Skeleton width={28} height={28} radius={8} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** "+ Add contacts" split: one primary trigger opening the three entry paths. */
function AddContactsSplit({
  onManual,
  onCsv,
  onMigrate,
}: {
  onManual: () => void;
  onCsv: () => void;
  onMigrate: () => void;
}) {
  const t = useTranslations("audience");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keydown only intercepts Escape bubbling from the trigger/menu
    <div
      ref={rootRef}
      style={{ position: "relative", display: "inline-flex" }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="ms-btn ms-btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PlusGlyph size={14} />
        {t("contacts.addContacts")}
        <ChevronGlyph size={12} direction={open ? "up" : "down"} />
      </button>
      {open ? (
        <div
          role="menu"
          className="ms-menu"
          style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: "max-content" }}
        >
          {(
            [
              [t("contacts.addManually"), onManual],
              [t("contacts.importCsv"), onCsv],
              [t("contacts.importResend"), onMigrate],
            ] as const
          ).map(([label, onSelect]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="ms-menu-item"
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The team's Contacts surface, rendered at /audience. `migrateToUrl` is null on Cloud. */
const sumCounts = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);

export function AudienceContactsView({ migrateToUrl }: { migrateToUrl: string | null }) {
  const t = useTranslations("audience");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  // Unknown segment/topic ids from the URL degrade gracefully: the list query
  // returns no rows and the Select renders an empty trigger label.
  const [search, setSearch] = useUrlState("q");
  const [limit, setLimit] = useState(40);
  const [segmentId, setSegmentId] = useUrlState("segment");
  const [topicId, setTopicId] = useUrlState("topic");
  const [statusParam, setStatus] = useUrlState("status");
  const status = oneOf(CONTACT_STATUSES, statusParam, "");
  const deferredSearch = useDeferredValue(search.trim());

  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");

  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<CsvContactRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; skipped: number } | null>(
    null,
  );
  const [importError, setImportError] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; email: string } | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseEmail, setEraseEmail] = useState("");

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [bulkModal, setBulkModal] = useState<
    "addSegments" | "removeSegment" | "subscribeTopics" | null
  >(null);
  const [bulkSegmentIds, setBulkSegmentIds] = useState<string[]>([]);
  const [bulkSegmentId, setBulkSegmentId] = useState("");
  const [bulkTopicIds, setBulkTopicIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  useDismiss(bulkMenuRef, bulkMenuOpen, () => setBulkMenuOpen(false));

  const role = useTeamRole();
  // Export and bulk delete are admin-only server-side.
  const canManage = role === "owner" || role === "admin";
  const segments = useQuery(trpc.segments.list.queryOptions());
  const stats = useQuery(trpc.audience.contacts.stats.queryOptions());
  const growth = useQuery(trpc.audience.contacts.growth.queryOptions());
  const topics = useQuery(trpc.topics.list.queryOptions());

  const query = useInfiniteQuery(
    trpc.audience.contacts.list.infiniteQueryOptions(
      {
        limit,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(status ? { status } : {}),
        ...(segmentId ? { segmentId } : {}),
        ...(topicId ? { topicId } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = deferredSearch !== "" || status !== "" || segmentId !== "" || topicId !== "";

  // Selection tracks the visible list: rows that fall out (filter/search
  // change, deletion) are pruned; rows still visible after a page-size change
  // or a "load more" stay selected. Pruning waits for data — a key change
  // (filter, page size) empties `items` while pending, and clearing on that
  // would drop rows the incoming page still shows.
  useEffect(() => {
    if (query.isPending) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(items.map((row) => row.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items, query.isPending]);

  // Export mirrors the on-screen view: the search box plus the active status,
  // segment and topic filters, so a filtered download matches the table.
  const exportParams = new URLSearchParams();
  if (deferredSearch) exportParams.set("search", deferredSearch);
  if (status) exportParams.set("status", status);
  if (segmentId) exportParams.set("segmentId", segmentId);
  if (topicId) exportParams.set("topicId", topicId);
  const exportQs = exportParams.toString();

  const invalidate = useCallback(
    () => queryClient.invalidateQueries(trpc.audience.pathFilter()),
    [queryClient, trpc],
  );

  const addMutation = useMutation(
    trpc.audience.contacts.add.mutationOptions({
      onSuccess: () => {
        setAddOpen(false);
        setNewEmail("");
        setNewFirst("");
        setNewLast("");
        invalidate();
      },
    }),
  );
  const addManyMutation = useMutation(trpc.audience.contacts.addMany.mutationOptions());
  const updateMutation = useMutation(
    trpc.audience.contacts.update.mutationOptions({ onSuccess: invalidate }),
  );
  const deleteMutation = useMutation(
    trpc.audience.contacts.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        invalidate();
      },
    }),
  );
  const bulkAddSegmentsMutation = useMutation(
    trpc.audience.contacts.bulkAddSegments.mutationOptions(),
  );
  const bulkRemoveSegmentMutation = useMutation(
    trpc.audience.contacts.bulkRemoveSegment.mutationOptions(),
  );
  const bulkSubscribeTopicsMutation = useMutation(
    trpc.audience.contacts.bulkSubscribeTopics.mutationOptions(),
  );
  const bulkDeleteMutation = useMutation(trpc.audience.contacts.bulkDelete.mutationOptions());
  const eraseMutation = useMutation(
    trpc.audience.eraseRecipient.mutationOptions({
      onSuccess: () => {
        setEraseOpen(false);
        setEraseEmail("");
        invalidate();
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose.
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);
  const closeErase = useCallback(() => {
    setEraseOpen(false);
    setEraseEmail("");
  }, []);
  const closeImport = useCallback(() => {
    setImportOpen(false);
    setImportRows(null);
    setImportResult(null);
    setImportError(false);
  }, []);
  const closeMigrate = useCallback(() => setMigrateOpen(false), []);
  const closeBulkModal = useCallback(() => setBulkModal(null), []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function openBulkModal(modal: NonNullable<typeof bulkModal>) {
    setBulkMenuOpen(false);
    setBulkSegmentIds([]);
    setBulkSegmentId("");
    setBulkTopicIds([]);
    setBulkError(false);
    setBulkModal(modal);
  }

  /** Runs one bulk mutation over the selection in server-cap-sized batches. */
  async function runBulk(run: (contactIds: string[]) => Promise<unknown>) {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(false);
    try {
      const ids = [...selected];
      for (let i = 0; i < ids.length; i += BULK_BATCH) {
        await run(ids.slice(i, i + BULK_BATCH));
      }
      setBulkModal(null);
      clearSelection();
      invalidate();
    } catch {
      setBulkError(true);
    } finally {
      setBulkBusy(false);
    }
  }

  const runBulkDelete = useCallback(async () => {
    if (bulkBusy || selected.size === 0) return;
    // Busy from confirm to commit: the ⌫ binding must not stack a second
    // confirm (a new confirmDialog cancels the one already open).
    setBulkBusy(true);
    setBulkError(false);
    try {
      const ok = await confirmDialog({
        title: t("contacts.bulk.deleteTitle"),
        message: t("contacts.bulk.deleteBody", { count: selected.size }),
        confirmLabel: t("contacts.bulk.deleteConfirm"),
        danger: true,
        typeToConfirm: true,
      });
      if (!ok) return;
      const ids = [...selected];
      for (let i = 0; i < ids.length; i += BULK_BATCH) {
        await bulkDeleteMutation.mutateAsync({ contactIds: ids.slice(i, i + BULK_BATCH) });
      }
      clearSelection();
      invalidate();
    } catch {
      setBulkError(true);
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, selected, t, bulkDeleteMutation.mutateAsync, clearSelection, invalidate]);

  const anyModalOpen =
    addOpen ||
    importOpen ||
    migrateOpen ||
    eraseOpen ||
    deleteTarget !== null ||
    bulkModal !== null ||
    bulkBusy;

  // Bulk keyboard bindings, live while a selection exists and no dialog or
  // text field owns the keys: E = edit menu, ⌫ = delete, Esc = clear.
  useEffect(() => {
    if (selected.size === 0) return;
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // A focused row checkbox is not "typing" — E/⌫/Esc must still work
      // right after a click selects a row.
      const typing =
        (target instanceof HTMLInputElement && target.type !== "checkbox") ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false);
      if (typing || anyModalOpen) return;
      if (event.key === "Escape") {
        if (bulkMenuOpen) setBulkMenuOpen(false);
        else clearSelection();
      } else if (event.key === "e" || event.key === "E") {
        event.preventDefault();
        setBulkMenuOpen((v) => !v);
      } else if (canManage && (event.key === "Backspace" || event.key === "Delete")) {
        event.preventDefault();
        void runBulkDelete();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, anyModalOpen, bulkMenuOpen, canManage, clearSelection, runBulkDelete]);

  function submitAdd() {
    if (addMutation.isPending || newEmail.trim().length === 0) return;
    addMutation.mutate({
      email: newEmail.trim(),
      ...(newFirst.trim() ? { firstName: newFirst.trim() } : {}),
      ...(newLast.trim() ? { lastName: newLast.trim() } : {}),
    });
  }

  function submitDelete() {
    if (!deleteTarget || deleteMutation.isPending) return;
    deleteMutation.mutate({ id: deleteTarget.id });
  }

  function submitErase() {
    if (eraseMutation.isPending || eraseEmail.trim().length === 0) return;
    eraseMutation.mutate({ email: eraseEmail.trim() });
  }

  async function runImport() {
    if (!importRows || importRows.length === 0 || importing) return;
    setImporting(true);
    setImportError(false);
    try {
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < importRows.length; i += IMPORT_BATCH) {
        const res = await addManyMutation.mutateAsync({
          rows: importRows.slice(i, i + IMPORT_BATCH),
        });
        created += res.created;
        skipped += res.skipped;
      }
      setImportResult({ created, skipped });
      invalidate();
    } catch {
      setImportError(true);
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("list.title")}
        actions={
          <>
            {canManage ? (
              <>
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  onClick={() => setEraseOpen(true)}
                >
                  {t("contacts.erase")}
                </button>
                <ExportCsvLink href={`/export/contacts${exportQs ? `?${exportQs}` : ""}`} />
              </>
            ) : null}
            <AddContactsSplit
              onManual={() => setAddOpen(true)}
              onCsv={() => setImportOpen(true)}
              onMigrate={() => setMigrateOpen(true)}
            />
            <ResourceApiButton resource="contacts" />
          </>
        }
      />
      <AudienceTabs />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr) auto",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          marginBottom: 20,
        }}
      >
        <StatBlock
          label={t("contacts.stats.all")}
          value={stats.data ? nf.format(stats.data.contacts) : null}
        />
        <StatBlock
          label={t("contacts.stats.subscribers")}
          value={stats.data ? nf.format(stats.data.contacts - stats.data.unsubscribed) : null}
        />
        <StatBlock
          label={t("contacts.stats.unsubscribed")}
          value={stats.data ? nf.format(stats.data.unsubscribed) : null}
        />
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("contacts.stats.metrics")}
          </div>
          <div style={{ marginTop: 6, display: "flex" }}>
            {growth.data && stats.data ? (
              <GrowthSparkline
                added={growth.data.added}
                unsubscribed={growth.data.unsubscribed}
                baseline={{
                  // The window's lines start from what existed before it;
                  // the clamp covers the two queries not sharing a snapshot.
                  total: Math.max(0, stats.data.contacts - sumCounts(growth.data.added)),
                  out: Math.max(0, stats.data.unsubscribed - sumCounts(growth.data.unsubscribed)),
                }}
                totalLabel={t("contacts.stats.subscribers")}
                outLabel={t("contacts.stats.unsubscribed")}
                formatDay={(day) => formatDayUtc(day, locale)}
                formatValue={(value) => nf.format(value)}
              />
            ) : (
              <Skeleton width={200} height={52} radius={6} />
            )}
          </div>
        </div>
      </div>

      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder={t("contacts.searchPlaceholder")}
        />
        {(segments.data ?? []).length > 0 ? (
          <Select
            value={segmentId}
            onChange={setSegmentId}
            ariaLabel={t("filters.segment")}
            width={180}
            options={[
              { value: "", label: t("filters.allContacts") },
              ...(segments.data ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        ) : null}
        <Select
          value={status}
          onChange={setStatus}
          ariaLabel={t("filters.status")}
          width={156}
          options={[
            { value: "", label: t("filters.anyStatus") },
            { value: "subscribed", label: t("contacts.subscribed") },
            { value: "unsubscribed", label: t("contacts.unsubscribedBadge") },
          ]}
        />
        {(topics.data ?? []).length > 0 ? (
          <Select
            value={topicId}
            onChange={setTopicId}
            ariaLabel={t("filters.topic")}
            width={180}
            options={[
              { value: "", label: t("filters.anyTopic") },
              ...(topics.data ?? []).map((tp) => ({ value: tp.id, label: tp.name })),
            ]}
          />
        ) : null}
      </div>

      {query.isPending ? (
        <ContactsSkeleton />
      ) : query.isError ? (
        <StateCard
          tone="error"
          headline={t("contacts.loadError")}
          actionLabel={t("contacts.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        filtered ? (
          <StateCard
            headline={t("contacts.noMatch")}
            actionLabel={t("contacts.clearSearch")}
            onAction={() => {
              setSearch("");
              setStatus("");
              setSegmentId("");
              setTopicId("");
            }}
          />
        ) : (
          <EmptyState
            area="audience"
            headline={t("contacts.empty")}
            body={t("contacts.emptyHint")}
          />
        )
      ) : (
        <>
          <Table gutter={28} style={{ tableLayout: "fixed" }}>
            <ContactsHead
              selectAll={
                <input
                  type="checkbox"
                  className="ms-checkbox"
                  aria-label={t("contacts.bulk.selectAll")}
                  checked={items.length > 0 && items.every((row) => selected.has(row.id))}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate =
                        selected.size > 0 && !items.every((row) => selected.has(row.id));
                    }
                  }}
                  onChange={() =>
                    // Any existing selection clears (indeterminate included);
                    // from nothing, every loaded row selects.
                    setSelected(selected.size > 0 ? new Set() : new Set(items.map((row) => row.id)))
                  }
                />
              }
            />
            <tbody>
              {items.map((row) => {
                const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
                const detailHref = `/audience/contacts/${row.id}`;
                const isSelected = selected.has(row.id);
                const statusBadge = (
                  <span
                    className={`ms-badge ${row.unsubscribed ? "ms-badge-neutral" : "ms-badge-success"}`}
                  >
                    {row.unsubscribed ? t("contacts.unsubscribedBadge") : t("contacts.subscribed")}
                    {!row.unsubscribed && row.topics.length > 1 ? (
                      <span className="ms-count">{row.topics.length}</span>
                    ) : null}
                  </span>
                );
                return (
                  <tr
                    key={row.id}
                    className={isSelected ? "hoverable row-selected" : "hoverable"}
                    onClick={() => router.push(detailHref)}
                  >
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only guard so toggling the checkbox does not also trigger the row navigation; keyboard users reach the checkbox directly */}
                    <td className="ms-check-cell" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="ms-checkbox"
                        aria-label={t("contacts.bulk.selectRow", { email: row.email })}
                        checked={isSelected}
                        onChange={() => toggleSelected(row.id)}
                      />
                    </td>
                    <td>
                      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <ContactAvatar email={row.email} name={name} size={24} />
                        <Link
                          className="ms-mono"
                          style={{
                            fontSize: 13,
                            flexShrink: 0,
                            maxWidth: "100%",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          href={detailHref}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {row.email}
                        </Link>
                        {/* A name that merely echoes the address (SES imports) adds no information. */}
                        {name && name.toLowerCase() !== row.email.toLowerCase() ? (
                          <span
                            style={{
                              color: "var(--ms-muted)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {name}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      {row.segments.length > 0 ? (
                        // First segment, then a "+N" count that lists the rest on
                        // hover — the joined list overflowed the column on
                        // contacts in every segment.
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            minWidth: 0,
                            color: "var(--ms-muted)",
                          }}
                        >
                          <span
                            title={row.segments[0]}
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {row.segments[0]}
                          </span>
                          {row.segments.length > 1 ? (
                            // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only guard so pinning the segments tooltip does not also trigger the row navigation
                            // biome-ignore lint/a11y/noStaticElementInteractions: click containment only, the tooltip trigger inside stays the interactive element
                            <span onClick={(event) => event.stopPropagation()}>
                              <Tooltip text={row.segments.join("\n")}>
                                <span className="ms-count">+{row.segments.length - 1}</span>
                              </Tooltip>
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ms-faint)" }}>—</span>
                      )}
                    </td>
                    <td>
                      {!row.unsubscribed && row.topics.length > 1 ? (
                        // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only guard so pinning the topics tooltip does not also trigger the row navigation
                        // biome-ignore lint/a11y/noStaticElementInteractions: click containment only, the tooltip trigger inside stays the interactive element
                        <span onClick={(event) => event.stopPropagation()}>
                          <Tooltip text={row.topics.join("\n")}>{statusBadge}</Tooltip>
                        </span>
                      ) : (
                        statusBadge
                      )}
                    </td>
                    <td className="right" style={{ color: "var(--ms-muted)" }}>
                      <RelativeTime date={row.createdAt} />
                    </td>
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only guard so a menu click does not also trigger the row navigation; keyboard users reach the menu button directly */}
                    <td
                      className="right"
                      style={{ width: 40 }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <PopoverMenu
                        ariaLabel={t("contacts.menu")}
                        items={[
                          {
                            label: row.unsubscribed
                              ? t("contacts.resubscribe")
                              : t("contacts.unsubscribe"),
                            onSelect: () =>
                              updateMutation.mutate({
                                id: row.id,
                                unsubscribed: !row.unsubscribed,
                              }),
                          },
                          null,
                          {
                            label: t("contacts.delete"),
                            danger: true,
                            onSelect: () => setDeleteTarget({ id: row.id, email: row.email }),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <ListFooter
            left={t("contacts.pageOf", {
              pages: query.data?.pages.length ?? 1,
              total: nf.format(total),
            })}
            size={limit}
            onSize={setLimit}
            sizeLabel={(size) => t("contacts.pageSize", { count: size })}
            singlePage={!query.hasNextPage && (query.data?.pages.length ?? 1) === 1}
            loadMore={
              query.hasNextPage
                ? {
                    label: t("contacts.loadMore"),
                    onClick: () => query.fetchNextPage(),
                    loading: query.isFetchingNextPage,
                  }
                : undefined
            }
          />
        </>
      )}

      <Modal open={addOpen} onClose={closeAdd} onConfirm={submitAdd} title={t("contacts.addTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitAdd();
          }}
        >
          <div className="ms-field">
            <label htmlFor="contact-email">{t("contacts.emailLabel")}</label>
            <input
              id="contact-email"
              className={`ms-input mono${addMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("contacts.emailPlaceholder")}
              disabled={addMutation.isPending}
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
            <div className="ms-field">
              <label htmlFor="contact-first">{t("contacts.firstNameLabel")}</label>
              <input
                id="contact-first"
                className="ms-input"
                style={{ width: "100%" }}
                disabled={addMutation.isPending}
                value={newFirst}
                onChange={(event) => setNewFirst(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="contact-last">{t("contacts.lastNameLabel")}</label>
              <input
                id="contact-last"
                className="ms-input"
                style={{ width: "100%" }}
                disabled={addMutation.isPending}
                value={newLast}
                onChange={(event) => setNewLast(event.target.value)}
              />
            </div>
          </div>
          {addMutation.isError ? (
            <p className="ms-field-error">
              {addMutation.error.data?.code === "CONFLICT"
                ? t("contacts.addExists")
                : t("contacts.addInvalid")}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeAdd}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={addMutation.isPending || newEmail.trim().length === 0}
            >
              <BtnSpinner on={addMutation.isPending} />
              {t("contacts.addConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal
        open={importOpen}
        onClose={closeImport}
        onConfirm={() => {
          if (importResult) closeImport();
          else void runImport();
        }}
        title={t("contacts.importTitle")}
      >
        <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("contacts.importBody")}
        </p>
        {importResult ? (
          <>
            <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)" }}>
              {t("contacts.importResult", {
                created: nf.format(importResult.created),
                skipped: nf.format(importResult.skipped),
              })}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}>
              <button type="button" className="ms-btn ms-btn-primary" onClick={closeImport}>
                {t("contacts.importDone")} <span className="ms-keycap">Esc</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="ms-field">
              <label htmlFor="contact-csv">{t("contacts.importFileLabel")}</label>
              <input
                id="contact-csv"
                type="file"
                accept=".csv,text/csv"
                className="ms-input"
                style={{ width: "100%" }}
                disabled={importing}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    setImportRows(null);
                    return;
                  }
                  void file.text().then((text) => setImportRows(parseCsvContacts(text)));
                }}
              />
            </div>
            {importRows ? (
              <p
                style={{
                  margin: "10px 0 0",
                  color: importRows.length === 0 ? "var(--ms-danger)" : "var(--ms-muted)",
                  fontSize: "var(--ms-fs-label)",
                }}
              >
                {importRows.length === 0
                  ? t("contacts.importNone")
                  : t("contacts.importPreview", { count: importRows.length })}
              </p>
            ) : null}
            {importError ? <p className="ms-field-error">{t("contacts.importError")}</p> : null}
            <ModalFooter>
              <button type="button" className="ms-btn ms-btn-secondary" onClick={closeImport}>
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={importing || !importRows || importRows.length === 0}
                onClick={() => void runImport()}
              >
                <BtnSpinner on={importing} />
                {t("contacts.importConfirm")}
              </button>
            </ModalFooter>
          </>
        )}
      </Modal>

      <Modal open={migrateOpen} onClose={closeMigrate} title={t("contacts.migrate.title")}>
        <p style={{ margin: "0 0 14px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("contacts.migrate.body")}
        </p>
        <CopyChip value={migrateCommand(migrateToUrl)} title={migrateCommand(migrateToUrl)} />
        <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          <a href={MIGRATE_DOCS_URL} target="_blank" rel="noreferrer">
            {t("contacts.migrate.docs")} ↗
          </a>
        </p>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeMigrate}>
            {common("close")} <span className="ms-keycap">Esc</span>
          </button>
        </ModalFooter>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        onConfirm={submitDelete}
        title={t("contacts.deleteTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitDelete();
          }}
        >
          <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("contacts.deleteBody", { email: deleteTarget?.email ?? "—" })}
          </p>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeDelete}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={deleteMutation.isPending}
            >
              <BtnSpinner on={deleteMutation.isPending} />
              {t("contacts.deleteConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal
        open={eraseOpen}
        onClose={closeErase}
        onConfirm={submitErase}
        title={t("contacts.eraseTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitErase();
          }}
        >
          <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("contacts.eraseBody")}
          </p>
          <div className="ms-field">
            <label htmlFor="erase-email">{t("contacts.emailLabel")}</label>
            <input
              id="erase-email"
              className={`ms-input mono${eraseMutation.isError ? " error" : ""}`}
              style={{ width: "100%" }}
              placeholder={t("contacts.emailPlaceholder")}
              disabled={eraseMutation.isPending}
              value={eraseEmail}
              onChange={(event) => setEraseEmail(event.target.value)}
            />
          </div>
          {eraseMutation.isError ? (
            <p className="ms-field-error">{t("contacts.eraseInvalid")}</p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeErase}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={eraseMutation.isPending || eraseEmail.trim().length === 0}
            >
              <BtnSpinner on={eraseMutation.isPending} />
              {t("contacts.eraseConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      {selected.size > 0 ? (
        <div className="ms-bulk-bar" role="toolbar" aria-label={t("contacts.bulk.edit")}>
          <span className="ms-bulk-count">
            {t("contacts.bulk.selected", { count: selected.size })}
          </span>
          <button
            type="button"
            className="ms-menu-trigger-bare"
            aria-label={t("contacts.bulk.clear")}
            onClick={clearSelection}
          >
            ✕
          </button>
          <span className="ms-bulk-sep" aria-hidden="true" />
          <div ref={bulkMenuRef} style={{ position: "relative", display: "inline-flex" }}>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              aria-haspopup="menu"
              aria-expanded={bulkMenuOpen}
              onClick={() => setBulkMenuOpen((v) => !v)}
            >
              {t("contacts.bulk.edit")} <span className="ms-keycap">E</span>
            </button>
            {bulkMenuOpen ? (
              <div
                role="menu"
                className="ms-menu"
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  left: 0,
                  width: "max-content",
                }}
              >
                {(
                  [
                    ["addSegments", t("contacts.bulk.addToSegments")],
                    ["removeSegment", t("contacts.bulk.removeFromSegment")],
                    ["subscribeTopics", t("contacts.bulk.subscribeToTopics")],
                  ] as const
                ).map(([modal, label]) => (
                  <button
                    key={modal}
                    type="button"
                    role="menuitem"
                    className="ms-menu-item"
                    onClick={() => openBulkModal(modal)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {canManage ? (
            <button
              type="button"
              className="ms-btn ms-btn-destructive"
              disabled={bulkBusy}
              onClick={() => void runBulkDelete()}
            >
              <BtnSpinner on={bulkBusy && bulkModal === null} />
              {t("contacts.bulk.delete")} <span className="ms-keycap">⌫</span>
            </button>
          ) : null}
          {bulkError && bulkModal === null ? (
            <span className="ms-field-error" style={{ margin: 0 }}>
              {t("contacts.bulk.error")}
            </span>
          ) : null}
        </div>
      ) : null}

      <Modal
        open={bulkModal === "addSegments"}
        onClose={closeBulkModal}
        onConfirm={() => {
          if (bulkSegmentIds.length > 0) {
            void runBulk((contactIds) =>
              bulkAddSegmentsMutation.mutateAsync({ contactIds, segmentIds: bulkSegmentIds }),
            );
          }
        }}
        title={t("contacts.bulk.addToSegments")}
      >
        <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("contacts.bulk.addSegmentsBody", { count: selected.size })}
        </p>
        <div className="ms-field">
          <label htmlFor="bulk-segments">{t("contacts.bulk.segmentsLabel")}</label>
          <ChipMultiSelect
            id="bulk-segments"
            value={bulkSegmentIds}
            onChange={setBulkSegmentIds}
            options={(segments.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            placeholder={t("contacts.bulk.segmentsPlaceholder")}
            ariaLabel={t("contacts.bulk.segmentsLabel")}
            removeLabel={(label) => t("detail.removeSegment", { name: label })}
            disabled={bulkBusy}
          />
        </div>
        {bulkError ? <p className="ms-field-error">{t("contacts.bulk.error")}</p> : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeBulkModal}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={bulkBusy || bulkSegmentIds.length === 0}
            onClick={() =>
              void runBulk((contactIds) =>
                bulkAddSegmentsMutation.mutateAsync({ contactIds, segmentIds: bulkSegmentIds }),
              )
            }
          >
            <BtnSpinner on={bulkBusy} />
            {t("contacts.bulk.addSegmentsConfirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>

      <Modal
        open={bulkModal === "removeSegment"}
        onClose={closeBulkModal}
        onConfirm={() => {
          if (bulkSegmentId !== "") {
            void runBulk((contactIds) =>
              bulkRemoveSegmentMutation.mutateAsync({ contactIds, segmentId: bulkSegmentId }),
            );
          }
        }}
        title={t("contacts.bulk.removeFromSegment")}
      >
        <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("contacts.bulk.removeSegmentBody", { count: selected.size })}
        </p>
        <div className="ms-field">
          <label htmlFor="bulk-segment">{t("contacts.bulk.segmentLabel")}</label>
          <Select
            id="bulk-segment"
            value={bulkSegmentId}
            onChange={setBulkSegmentId}
            ariaLabel={t("contacts.bulk.segmentLabel")}
            width="100%"
            options={(segments.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
        {bulkError ? <p className="ms-field-error">{t("contacts.bulk.error")}</p> : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeBulkModal}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={bulkBusy || bulkSegmentId === ""}
            onClick={() =>
              void runBulk((contactIds) =>
                bulkRemoveSegmentMutation.mutateAsync({ contactIds, segmentId: bulkSegmentId }),
              )
            }
          >
            <BtnSpinner on={bulkBusy} />
            {t("contacts.bulk.removeSegmentConfirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>

      <Modal
        open={bulkModal === "subscribeTopics"}
        onClose={closeBulkModal}
        onConfirm={() => {
          if (bulkTopicIds.length > 0) {
            void runBulk((contactIds) =>
              bulkSubscribeTopicsMutation.mutateAsync({ contactIds, topicIds: bulkTopicIds }),
            );
          }
        }}
        title={t("contacts.bulk.subscribeToTopics")}
      >
        <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("contacts.bulk.subscribeTopicsBody", { count: selected.size })}
        </p>
        <div className="ms-field">
          <label htmlFor="bulk-topics">{t("contacts.bulk.topicsLabel")}</label>
          <ChipMultiSelect
            id="bulk-topics"
            value={bulkTopicIds}
            onChange={setBulkTopicIds}
            options={(topics.data ?? []).map((tp) => ({ value: tp.id, label: tp.name }))}
            placeholder={t("contacts.bulk.topicsPlaceholder")}
            ariaLabel={t("contacts.bulk.topicsLabel")}
            removeLabel={(label) => t("detail.removeTopic", { name: label })}
            disabled={bulkBusy}
          />
        </div>
        {bulkError ? <p className="ms-field-error">{t("contacts.bulk.error")}</p> : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeBulkModal}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={bulkBusy || bulkTopicIds.length === 0}
            onClick={() =>
              void runBulk((contactIds) =>
                bulkSubscribeTopicsMutation.mutateAsync({ contactIds, topicIds: bulkTopicIds }),
              )
            }
          >
            <BtnSpinner on={bulkBusy} />
            {t("contacts.bulk.subscribeTopicsConfirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>
    </>
  );
}
