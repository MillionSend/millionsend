"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { formatUtcMinute } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
        {label}
      </p>
      <div style={{ marginTop: 5, fontSize: 14, color: "var(--ms-bone)" }}>{children}</div>
    </div>
  );
}

export default function ContactDetailPage() {
  const { contactId } = useParams<{ id: string; contactId: string }>();
  const t = useTranslations("audience");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const query = useQuery(
    trpc.audience.contacts.get.queryOptions({ id: contactId }, { retry: false }),
  );

  const invalidate = () => queryClient.invalidateQueries(trpc.audience.pathFilter());
  const updateMutation = useMutation(
    trpc.audience.contacts.update.mutationOptions({
      onSuccess: () => {
        setEditOpen(false);
        invalidate();
      },
    }),
  );
  const deleteMutation = useMutation(
    trpc.audience.contacts.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        router.push(`/audience/${query.data?.audienceId}`);
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose.
  const closeEdit = useCallback(() => setEditOpen(false), []);
  const closeDelete = useCallback(() => setConfirmingDelete(false), []);

  if (query.isError) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("detail.notFound")}
        </p>
        <Link href="/audience" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("list.title")}
        </Link>
      </>
    );
  }

  const row = query.isSuccess ? query.data : null;
  const name = row ? [row.firstName, row.lastName].filter(Boolean).join(" ") : "";

  return (
    <>
      {row ? (
        <PageHeader
          breadcrumb={
            <>
              <Crumb href="/audience" label={t("list.title")} />
              <Crumb href={`/audience/${row.audienceId}`} label={row.audienceName} />
              <CrumbEnd label={t("detail.eyebrow")} />
            </>
          }
          title={row.email}
          {...(name ? { subtitle: name } : {})}
          actions={
            <>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => {
                  setEditFirst(row.firstName ?? "");
                  setEditLast(row.lastName ?? "");
                  setEditOpen(true);
                }}
              >
                {t("detail.edit")}
              </button>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={updateMutation.isPending}
                onClick={() =>
                  updateMutation.mutate({ id: row.id, unsubscribed: !row.unsubscribed })
                }
              >
                <BtnSpinner on={updateMutation.isPending} />
                {row.unsubscribed ? t("contacts.resubscribe") : t("contacts.unsubscribe")}
              </button>
              <button
                type="button"
                className="ms-btn ms-btn-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                {t("contacts.delete")}
              </button>
            </>
          }
        />
      ) : (
        // Mirrors the loaded PageHeader's boxes (breadcrumb + H1 + actions).
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
              <Skeleton width={200} height="1lh" />
            </div>
            <h1
              className="ms-display"
              style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
            >
              <Skeleton width={300} height="1lh" />
            </h1>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Skeleton width={64} height={30} radius="var(--ms-r-input)" />
            <Skeleton width={106} height={30} radius="var(--ms-r-input)" />
            <Skeleton width={72} height={30} radius="var(--ms-r-input)" />
          </div>
        </div>
      )}

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <MetaItem label={t("detail.email")}>
          {row ? <CopyChip value={row.email} /> : <SkeletonChip width={180} />}
        </MetaItem>
        <MetaItem label={t("detail.created")}>
          {row ? formatUtcMinute(row.createdAt) : <Skeleton width={130} height={14} />}
        </MetaItem>
        <MetaItem label={t("detail.status")}>
          {row ? (
            <span
              className={`ms-badge ${row.unsubscribed ? "ms-badge-neutral" : "ms-badge-success"}`}
            >
              {row.unsubscribed ? t("contacts.unsubscribedBadge") : t("contacts.subscribed")}
            </span>
          ) : (
            <SkeletonBadge width={82} />
          )}
        </MetaItem>
        <MetaItem label={t("detail.id")}>
          {row ? (
            <CopyChip value={row.id} display={`${row.id.slice(0, 8)}…`} title={row.id} />
          ) : (
            <SkeletonChip width={110} />
          )}
        </MetaItem>
      </div>

      <Modal open={editOpen} onClose={closeEdit} title={t("detail.editTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!row || updateMutation.isPending) return;
            updateMutation.mutate({
              id: row.id,
              firstName: editFirst.trim(),
              lastName: editLast.trim(),
            });
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="ms-field">
              <label htmlFor="edit-first">{t("contacts.firstNameLabel")}</label>
              <input
                id="edit-first"
                className="ms-input"
                style={{ width: "100%" }}
                disabled={updateMutation.isPending}
                value={editFirst}
                onChange={(event) => setEditFirst(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="edit-last">{t("contacts.lastNameLabel")}</label>
              <input
                id="edit-last"
                className="ms-input"
                style={{ width: "100%" }}
                disabled={updateMutation.isPending}
                value={editLast}
                onChange={(event) => setEditLast(event.target.value)}
              />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={closeEdit}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={updateMutation.isPending}
            >
              <BtnSpinner on={updateMutation.isPending} />
              {t("detail.saveConfirm")} <span className="ms-keycap">↵</span>
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={confirmingDelete} onClose={closeDelete} title={t("contacts.deleteTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (row && !deleteMutation.isPending) deleteMutation.mutate({ id: row.id });
          }}
        >
          <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("contacts.deleteBody", { email: row?.email ?? "—" })}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={closeDelete}>
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
          </div>
        </form>
      </Modal>
    </>
  );
}
