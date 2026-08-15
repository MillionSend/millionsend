"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ChevronGlyph, PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu, useDismiss } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { type CsvContactRow, parseCsvContacts } from "@/lib/csv";
import { useTRPC } from "@/lib/trpc";
import { ListFooter, SearchBox, StateCard } from "../../emails/list-parts";

/** addMany's input ceiling — larger CSVs go up in sequential batches. */
const IMPORT_BATCH = 1000;

function ContactsHead({ action = true }: { action?: boolean }) {
  const t = useTranslations("audience");
  return (
    <thead>
      <tr>
        <th style={{ width: "34%" }}>{t("contacts.email")}</th>
        <th style={{ width: "24%" }}>{t("contacts.name")}</th>
        <th style={{ width: "15%" }}>{t("contacts.status")}</th>
        <th className="right">{t("contacts.added")}</th>
        {action ? <th className="right" /> : null}
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

/** Uppercase microlabel over big tabular digits; the ghost keeps the digit line box. */
function StatBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
        {label}
      </div>
      <div
        className="ms-digits"
        style={{
          fontSize: "var(--ms-fs-kpi)",
          color: "var(--ms-bone)",
          marginTop: 6,
          display: "flex",
        }}
      >
        {value ?? <Skeleton width={64} height="1lh" />}
      </div>
    </div>
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

export default function AudienceContactsPage() {
  const { id: audienceId } = useParams<{ id: string }>();
  const t = useTranslations("audience");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(40);
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

  const audience = useQuery(
    trpc.audience.audiences.get.queryOptions({ id: audienceId }, { retry: false }),
  );
  const query = useInfiniteQuery(
    trpc.audience.contacts.list.infiniteQueryOptions(
      { audienceId, limit, ...(deferredSearch ? { search: deferredSearch } : {}) },
      { getNextPageParam: (page) => page.nextCursor, enabled: audience.isSuccess },
    ),
  );
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

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

  async function runImport() {
    if (!importRows || importRows.length === 0 || importing) return;
    setImporting(true);
    setImportError(false);
    try {
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < importRows.length; i += IMPORT_BATCH) {
        const res = await addManyMutation.mutateAsync({
          audienceId,
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

  if (audience.isError) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("contacts.notFound")}
        </p>
        <Link href="/audience" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("contacts.back")}
        </Link>
      </>
    );
  }

  const stats = audience.data ?? null;

  return (
    <>
      {stats ? (
        <PageHeader
          breadcrumb={
            <>
              <Crumb href="/audience" label={t("list.title")} />
              <CrumbEnd label={stats.name} />
            </>
          }
          title={stats.name}
          actions={
            <AddContactsSplit onManual={() => setAddOpen(true)} onCsv={() => setImportOpen(true)} />
          }
        />
      ) : (
        // Mirrors the loaded PageHeader's boxes (breadcrumb line + H1) so
        // nothing shifts when the audience lands.
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <div>
            <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
              <Skeleton width={150} height="1lh" />
            </div>
            <h1
              className="ms-display"
              style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
            >
              <Skeleton width={220} height="1lh" />
            </h1>
          </div>
          <AddContactsSplit onManual={() => setAddOpen(true)} onCsv={() => setImportOpen(true)} />
        </div>
      )}

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          marginBottom: 20,
        }}
      >
        <StatBlock
          label={t("contacts.stats.all")}
          value={stats ? nf.format(stats.contacts) : null}
        />
        <StatBlock
          label={t("contacts.stats.subscribers")}
          value={stats ? nf.format(stats.contacts - stats.unsubscribed) : null}
        />
        <StatBlock
          label={t("contacts.stats.unsubscribed")}
          value={stats ? nf.format(stats.unsubscribed) : null}
        />
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
      </div>

      {query.isPending || audience.isPending ? (
        <ContactsSkeleton />
      ) : query.isError ? (
        <StateCard
          headline={t("contacts.loadError")}
          actionLabel={t("contacts.retry")}
          onAction={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        deferredSearch !== "" ? (
          <StateCard
            headline={t("contacts.noMatch")}
            actionLabel={t("contacts.clearSearch")}
            onAction={() => setSearch("")}
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
                const detailHref = `/audience/${audienceId}/contacts/${row.id}`;
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
          />
        </>
      )}

      <Modal open={addOpen} onClose={closeAdd} title={t("contacts.addTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (addMutation.isPending || newEmail.trim().length === 0) return;
            addMutation.mutate({
              audienceId,
              email: newEmail.trim(),
              ...(newFirst.trim() ? { firstName: newFirst.trim() } : {}),
              ...(newLast.trim() ? { lastName: newLast.trim() } : {}),
            });
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
              {t("contacts.addConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal open={importOpen} onClose={closeImport} title={t("contacts.importTitle")}>
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

      <Modal open={deleteTarget !== null} onClose={closeDelete} title={t("contacts.deleteTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (deleteTarget && !deleteMutation.isPending) {
              deleteMutation.mutate({ id: deleteTarget.id });
            }
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
              {t("contacts.deleteConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
