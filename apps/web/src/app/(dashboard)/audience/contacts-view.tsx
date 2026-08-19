"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
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
import { type CsvContactRow, parseCsvContacts } from "@/lib/csv";
import { useTRPC } from "@/lib/trpc";
import { useUrlState } from "@/lib/url-state";
import { ListFooter, SearchBox, StateCard } from "../emails/list-parts";
import { AudienceTabs } from "./audience-tabs";

/** addMany's input ceiling — larger CSVs go up in sequential batches. */
const IMPORT_BATCH = 1000;

function ContactsHead() {
  const t = useTranslations("audience");
  return (
    <thead>
      <tr>
        <th style={{ width: "34%" }}>{t("contacts.email")}</th>
        <th style={{ width: "24%" }}>{t("contacts.name")}</th>
        <th style={{ width: "15%" }}>{t("contacts.status")}</th>
        <th className="right">{t("contacts.added")}</th>
        <th className="right" />
      </tr>
    </thead>
  );
}

/** Mirrors the loaded contacts table: mono email, name, badge, time, action trigger. */
function ContactsSkeleton() {
  const widths = ["58%", "42%", "66%", "50%", "38%"];
  return (
    <Table>
      <ContactsHead />
      <tbody>
        {widths.map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <tr key={row}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={widths[widths.length - 1 - row] ?? "50%"} />
            </td>
            <td>
              <SkeletonBadge width={82} />
            </td>
            <td className="right">
              <Skeleton width={48} />
            </td>
            <td className="right" style={{ width: 40 }}>
              <Skeleton width={22} height={30} radius="var(--ms-r-input)" />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** "+ Add contacts" split: one primary trigger opening the two entry paths. */
function AddContactsSplit({ onManual, onCsv }: { onManual: () => void; onCsv: () => void }) {
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

/** The team's Contacts surface, rendered at /audience. */
export function AudienceContactsView() {
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

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; email: string } | null>(null);

  const segments = useQuery(trpc.segments.list.queryOptions());
  const stats = useQuery(trpc.audience.contacts.stats.queryOptions());
  const growth = useQuery(trpc.audience.contacts.growth.queryOptions());
  const topics = useQuery(trpc.topics.list.queryOptions());

  const query = useInfiniteQuery(
    trpc.audience.contacts.list.infiniteQueryOptions(
      {
        limit,
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(segmentId ? { segmentId } : {}),
        ...(topicId ? { topicId } : {}),
      },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = deferredSearch !== "" || segmentId !== "" || topicId !== "";

  // Export mirrors the on-screen view: the search box plus the active segment
  // and topic filters, so a filtered download matches the table.
  const exportParams = new URLSearchParams();
  if (deferredSearch) exportParams.set("search", deferredSearch);
  if (segmentId) exportParams.set("segmentId", segmentId);
  if (topicId) exportParams.set("topicId", topicId);
  const exportQs = exportParams.toString();

  const invalidate = () => queryClient.invalidateQueries(trpc.audience.pathFilter());

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

  // Stable identities: Modal's focus effect depends on onClose.
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);
  const closeImport = useCallback(() => {
    setImportOpen(false);
    setImportRows(null);
    setImportResult(null);
    setImportError(false);
  }, []);

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
            <ExportCsvLink href={`/export/contacts${exportQs ? `?${exportQs}` : ""}`} />
            <AddContactsSplit onManual={() => setAddOpen(true)} onCsv={() => setImportOpen(true)} />
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
            {growth.data ? (
              <GrowthSparkline added={growth.data.added} unsubscribed={growth.data.unsubscribed} />
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
          <Table>
            <ContactsHead />
            <tbody>
              {items.map((row) => {
                const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
                const detailHref = `/audience/contacts/${row.id}`;
                return (
                  <tr key={row.id} className="hoverable" onClick={() => router.push(detailHref)}>
                    <td className="ms-mono" style={{ fontSize: 13 }}>
                      <Link href={detailHref} onClick={(event) => event.stopPropagation()}>
                        {row.email}
                      </Link>
                    </td>
                    <td>{name || <span style={{ color: "var(--ms-faint)" }}>—</span>}</td>
                    <td>
                      <span
                        className={`ms-badge ${row.unsubscribed ? "ms-badge-neutral" : "ms-badge-success"}`}
                      >
                        {row.unsubscribed
                          ? t("contacts.unsubscribedBadge")
                          : t("contacts.subscribed")}
                      </span>
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
          {query.hasNextPage ? (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {t("contacts.loadMore")}
              </button>
            </div>
          ) : null}
          <ListFooter
            left={t("contacts.pageOf", {
              pages: query.data?.pages.length ?? 1,
              total: nf.format(total),
            })}
            size={limit}
            onSize={setLimit}
            sizeLabel={(size) => t("contacts.pageSize", { count: size })}
            singlePage={!query.hasNextPage && (query.data?.pages.length ?? 1) === 1}
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
            <p
              style={{
                margin: "8px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
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
            {importError ? (
              <p
                style={{
                  margin: "10px 0 0",
                  color: "var(--ms-danger)",
                  fontSize: "var(--ms-fs-label)",
                }}
              >
                {t("contacts.importError")}
              </p>
            ) : null}
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
    </>
  );
}
