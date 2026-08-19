"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { ChipMultiSelect } from "@/components/chip-multi-select";
import { confirmDialog } from "@/components/confirm-dialog";
import { ContactAvatar } from "@/components/contact-avatar";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";

/* Types the timeline knows how to phrase; unknown kinds (added later than this
   build) are skipped rather than crashing on a missing message key. */
const ACTIVITY_TYPES = [
  "contact_created",
  "topic_opt_in",
  "topic_opt_out",
  "unsubscribed",
  "resubscribed",
  "segment_added",
  "segment_removed",
] as const;
type KnownActivityType = (typeof ACTIVITY_TYPES)[number];

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

function EmptyValue() {
  return <span style={{ color: "var(--ms-faint)" }}>—</span>;
}

/** Wrapping row of name pills (segments / topics on the detail page). */
function ChipList({ names, emptyLabel }: { names: string[]; emptyLabel: string }) {
  if (names.length === 0) {
    return (
      <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--ms-muted)" }}>{emptyLabel}</p>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {names.map((name) => (
        <span key={name} className="ms-chip">
          {name}
        </span>
      ))}
    </div>
  );
}

export default function ContactDetailPage() {
  const { contactId } = useParams<{ contactId: string }>();
  const t = useTranslations("audience");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editTopics, setEditTopics] = useState<string[]>([]);
  const [editProps, setEditProps] = useState<{ key: string; value: string }[]>([]);
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
        router.push("/audience");
      },
    }),
  );

  const topicsQuery = useQuery(
    trpc.audience.contacts.topics.queryOptions({ contactId }, { retry: false }),
  );
  const segmentsQuery = useQuery(
    trpc.audience.contacts.segments.queryOptions({ contactId }, { retry: false }),
  );
  const activitiesQuery = useQuery(
    trpc.audience.contacts.activities.queryOptions({ contactId }, { retry: false }),
  );
  const setTopicMutation = useMutation(trpc.audience.contacts.setTopic.mutationOptions());

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
  const subscribedTopics = (topicsQuery.data ?? []).filter((topic) => topic.subscribed);
  const saving = updateMutation.isPending || setTopicMutation.isPending;

  const openEdit = () => {
    if (!row) return;
    setEditFirst(row.firstName ?? "");
    setEditLast(row.lastName ?? "");
    setEditTopics(subscribedTopics.map((topic) => topic.id));
    setEditProps(Object.entries(row.properties).map(([key, value]) => ({ key, value })));
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (!row || saving) return;
    // Rows with a blank key are dropped; a repeated key keeps its
    // last value. Sent as the full replacement map (update semantics).
    const properties: Record<string, string> = {};
    for (const { key, value } of editProps) {
      const k = key.trim();
      if (k) properties[k] = value;
    }
    // Topic diffs go through the existing per-topic upsert; only effective
    // state that actually changed writes an override row.
    const selected = new Set(editTopics);
    const diffs = (topicsQuery.data ?? []).filter(
      (topic) => topic.subscribed !== selected.has(topic.id),
    );
    try {
      for (const topic of diffs) {
        await setTopicMutation.mutateAsync({
          contactId,
          topicId: topic.id,
          subscribed: selected.has(topic.id),
        });
      }
    } catch {
      return; // keep the dialog open; the mutation error stays visible
    }
    updateMutation.mutate({
      id: row.id,
      firstName: editFirst.trim(),
      lastName: editLast.trim(),
      properties,
    });
  };

  const toggleSubscription = async () => {
    if (!row || updateMutation.isPending) return;
    if (!row.unsubscribed) {
      const ok = await confirmDialog({
        message: t("detail.unsubscribeBody", { email: row.email }),
        confirmLabel: t("contacts.unsubscribe"),
        danger: true,
      });
      if (!ok) return;
    }
    updateMutation.mutate({ id: row.id, unsubscribed: !row.unsubscribed });
  };

  const submitDelete = () => {
    if (row && !deleteMutation.isPending) deleteMutation.mutate({ id: row.id });
  };

  const activities = (activitiesQuery.data ?? []).filter((a) =>
    (ACTIVITY_TYPES as readonly string[]).includes(a.type),
  );

  return (
    <>
      {row ? (
        <PageHeader
          breadcrumb={
            <>
              <Crumb href="/audience" label={t("list.title")} />
              <CrumbEnd label={row.email} />
            </>
          }
          eyebrow={t("detail.eyebrow")}
          title={row.email}
          leading={<ContactAvatar email={row.email} name={name} size={44} />}
          actions={
            <>
              {/* Enabled only once topics resolve: the dialog seeds its chip list
                  from them, and an empty seed would read as "opt out of all". */}
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={!topicsQuery.isSuccess}
                onClick={openEdit}
              >
                {t("detail.edit")}
              </button>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={updateMutation.isPending}
                onClick={() => void toggleSubscription()}
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
        // Mirrors the loaded PageHeader's boxes (breadcrumb + avatar + H1 + actions).
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
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <Skeleton width={44} height={44} radius="50%" />
              <h1
                className="ms-display"
                style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
              >
                <Skeleton width={300} height="1lh" />
              </h1>
            </div>
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
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
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
          {row ? <RelativeTime date={row.createdAt} /> : <Skeleton width={130} height={14} />}
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
          {/* The chip's own overflow CSS end-ellipsizes only under real space pressure. */}
          {row ? <CopyChip value={row.id} /> : <SkeletonChip width={110} />}
        </MetaItem>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 22,
          padding: "20px 0",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <div>
          <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
            {t("detail.segments")}
          </p>
          {segmentsQuery.isSuccess ? (
            <ChipList
              names={segmentsQuery.data.map((s) => s.name)}
              emptyLabel={t("detail.noSegments")}
            />
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <SkeletonChip width={90} />
              <SkeletonChip width={70} />
            </div>
          )}
        </div>
        <div>
          <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
            {t("detail.topics")}
          </p>
          {topicsQuery.isSuccess ? (
            <ChipList
              names={subscribedTopics.map((topic) => topic.name)}
              emptyLabel={t("detail.noTopics")}
            />
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <SkeletonChip width={90} />
              <SkeletonChip width={70} />
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: "20px 0", borderBottom: "1px solid var(--ms-line)" }}>
        <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
          {t("detail.properties")}
        </p>
        {row ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: "16px 22px",
              marginTop: 12,
            }}
          >
            <MetaItem label={t("detail.firstName")}>{row.firstName || <EmptyValue />}</MetaItem>
            <MetaItem label={t("detail.lastName")}>{row.lastName || <EmptyValue />}</MetaItem>
            {Object.entries(row.properties).map(([key, value]) => (
              <MetaItem key={key} label={key}>
                {value || <EmptyValue />}
              </MetaItem>
            ))}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: "16px 22px",
              marginTop: 12,
            }}
          >
            <Skeleton width={90} height={14} />
            <Skeleton width={160} height={14} />
            <Skeleton width={70} height={14} />
            <Skeleton width={120} height={14} />
          </div>
        )}
      </div>

      <div style={{ padding: "20px 0" }}>
        <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
          {t("detail.activity.title")}
        </p>
        {activitiesQuery.isSuccess ? (
          activities.length === 0 ? (
            <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--ms-muted)" }}>
              {t("detail.activity.empty")}
            </p>
          ) : (
            <div className="ms-card" style={{ marginTop: 12, padding: "8px 18px" }}>
              {activities.map((activity, index) => {
                const activityName =
                  typeof activity.data?.name === "string" ? activity.data.name : "";
                return (
                  <div key={activity.id} style={{ display: "flex", gap: 12 }}>
                    <div
                      aria-hidden="true"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        width: 12,
                        flex: "none",
                      }}
                    >
                      <span
                        style={{
                          width: 1,
                          height: 14,
                          flex: "none",
                          background: index === 0 ? "transparent" : "var(--ms-line)",
                        }}
                      />
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          flex: "none",
                          boxSizing: "border-box",
                          ...(activity.type === "contact_created"
                            ? { border: "1.5px solid var(--ms-line-strong)" }
                            : { background: "var(--ms-line-strong)" }),
                        }}
                      />
                      <span
                        style={{
                          width: 1,
                          flex: 1,
                          background:
                            index === activities.length - 1 ? "transparent" : "var(--ms-line)",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: 12,
                        padding: "8px 0 14px",
                      }}
                    >
                      <span style={{ fontSize: 14, color: "var(--ms-bone)" }}>
                        {t(`detail.activity.${activity.type as KnownActivityType}`, {
                          name: activityName,
                        })}
                      </span>
                      <span style={{ fontSize: 12.5, color: "var(--ms-muted)", flex: "none" }}>
                        <RelativeTime date={activity.createdAt} />
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="40%" height={14} />
          </div>
        )}
      </div>

      <Modal
        open={editOpen}
        onClose={closeEdit}
        onConfirm={() => void submitEdit()}
        title={t("detail.editTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitEdit();
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="ms-field">
              <label htmlFor="edit-first">{t("contacts.firstNameLabel")}</label>
              <input
                id="edit-first"
                className="ms-input"
                style={{ width: "100%" }}
                disabled={saving}
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
                disabled={saving}
                value={editLast}
                onChange={(event) => setEditLast(event.target.value)}
              />
            </div>
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="edit-topics">{t("detail.topics")}</label>
            <ChipMultiSelect
              id="edit-topics"
              value={editTopics}
              onChange={setEditTopics}
              options={(topicsQuery.data ?? []).map((topic) => ({
                value: topic.id,
                label: topic.name,
              }))}
              placeholder={t("detail.topicsPlaceholder")}
              ariaLabel={t("detail.topics")}
              removeLabel={(label) => t("detail.removeTopic", { name: label })}
              disabled={saving}
            />
          </div>
          <div style={{ marginTop: 18 }}>
            <p className="ms-microlabel" style={{ margin: "0 0 8px", fontSize: 10.5 }}>
              {t("detail.properties")}
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {editProps.map((prop, i) => (
                // Rows are positional and may hold blank keys mid-edit, so the
                // array index is the only stable identity here.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id per row
                <div key={i} style={{ display: "flex", gap: 8 }}>
                  <input
                    className="ms-input"
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder={t("detail.propKeyPlaceholder")}
                    disabled={saving}
                    value={prop.key}
                    onChange={(event) =>
                      setEditProps((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, key: event.target.value } : r)),
                      )
                    }
                  />
                  <input
                    className="ms-input"
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder={t("detail.propValuePlaceholder")}
                    disabled={saving}
                    value={prop.value}
                    onChange={(event) =>
                      setEditProps((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, value: event.target.value } : r)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="ms-btn ms-btn-ghost"
                    aria-label={t("detail.removeProperty")}
                    disabled={saving}
                    onClick={() => setEditProps((rows) => rows.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              // Zero side padding: the ghost label sits flush with the field column above.
              style={{ marginTop: 8, paddingLeft: 0, paddingRight: 0 }}
              disabled={saving}
              onClick={() => setEditProps((rows) => [...rows, { key: "", value: "" }])}
            >
              {t("detail.addProperty")}
            </button>
          </div>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeEdit}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={saving}>
              <BtnSpinner on={saving} />
              {t("detail.saveConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <Modal
        open={confirmingDelete}
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
            {t("contacts.deleteBody", { email: row?.email ?? "—" })}
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
