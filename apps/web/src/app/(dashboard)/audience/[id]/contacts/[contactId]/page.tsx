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

/** Zero-CSS toggle: an ARIA switch styled from tokens, on = success steel. */
function TopicSwitch({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      style={{
        flexShrink: 0,
        width: 34,
        height: 20,
        padding: 2,
        border: 0,
        borderRadius: 999,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        background: on ? "var(--ms-success)" : "var(--ms-line-strong)",
        transition: "background var(--ms-motion-fast, 120ms) ease",
        display: "flex",
        justifyContent: on ? "flex-end" : "flex-start",
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--ms-bone)",
        }}
      />
    </button>
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
        router.push(`/audience/${query.data?.audienceId}`);
      },
    }),
  );

  const topicsQuery = useQuery(
    trpc.audience.contacts.topics.queryOptions({ contactId }, { retry: false }),
  );
  const setTopicMutation = useMutation(
    trpc.audience.contacts.setTopic.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.audience.contacts.topics.pathFilter()),
    }),
  );
  const pendingTopicId = setTopicMutation.isPending
    ? setTopicMutation.variables?.topicId
    : undefined;

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
                  setEditProps(
                    Object.entries(row.properties).map(([key, value]) => ({ key, value })),
                  );
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

      <div style={{ padding: "20px 0", borderBottom: "1px solid var(--ms-line)" }}>
        <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
          {t("detail.properties")}
        </p>
        {row ? (
          Object.keys(row.properties).length === 0 ? (
            <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--ms-muted)" }}>
              {t("detail.noProperties")}
            </p>
          ) : (
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, max-content) 1fr",
                gap: "6px 22px",
                margin: "10px 0 0",
              }}
            >
              {Object.entries(row.properties).map(([key, value]) => (
                <div key={key} style={{ display: "contents" }}>
                  <dt style={{ fontSize: 14, color: "var(--ms-muted)" }}>{key}</dt>
                  <dd style={{ margin: 0, fontSize: 14, color: "var(--ms-bone)" }}>{value}</dd>
                </div>
              ))}
            </dl>
          )
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(120px, max-content) 1fr",
              gap: "6px 22px",
              marginTop: 10,
            }}
          >
            <Skeleton width={90} height={14} />
            <Skeleton width={160} height={14} />
            <Skeleton width={70} height={14} />
            <Skeleton width={120} height={14} />
          </div>
        )}
      </div>

      <div style={{ padding: "20px 0", borderBottom: "1px solid var(--ms-line)" }}>
        <p className="ms-microlabel" style={{ margin: 0, fontSize: 10.5 }}>
          {t("detail.topics")}
        </p>
        {row && topicsQuery.isSuccess ? (
          topicsQuery.data.length === 0 ? (
            <p style={{ margin: "8px 0 0", fontSize: 14, color: "var(--ms-muted)" }}>
              {t("detail.noTopics")}
            </p>
          ) : (
            <div style={{ display: "grid", gap: 14, margin: "12px 0 0" }}>
              {topicsQuery.data.map((topic) => (
                <div key={topic.id} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>{topic.name}</div>
                    {topic.description ? (
                      <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 2 }}>
                        {topic.description}
                      </div>
                    ) : null}
                  </div>
                  <TopicSwitch
                    on={topic.subscribed}
                    label={t("detail.topicToggle", { name: topic.name })}
                    disabled={pendingTopicId === topic.id}
                    onToggle={() =>
                      setTopicMutation.mutate({
                        contactId,
                        topicId: topic.id,
                        subscribed: !topic.subscribed,
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )
        ) : (
          <div style={{ display: "grid", gap: 14, margin: "12px 0 0" }}>
            {[64, 48].map((w) => (
              <div key={w} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Skeleton width={`${w + 40}px`} height={14} />
                </div>
                <Skeleton width={34} height={20} radius={999} />
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={editOpen} onClose={closeEdit} title={t("detail.editTitle")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!row || updateMutation.isPending) return;
            // Rows with a blank key are dropped; a repeated key keeps its
            // last value. Sent as the full replacement map (update semantics).
            const properties: Record<string, string> = {};
            for (const { key, value } of editProps) {
              const k = key.trim();
              if (k) properties[k] = value;
            }
            updateMutation.mutate({
              id: row.id,
              firstName: editFirst.trim(),
              lastName: editLast.trim(),
              properties,
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
                    disabled={updateMutation.isPending}
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
                    disabled={updateMutation.isPending}
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
                    disabled={updateMutation.isPending}
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
              style={{ marginTop: 8 }}
              disabled={updateMutation.isPending}
              onClick={() => setEditProps((rows) => [...rows, { key: "", value: "" }])}
            >
              {t("detail.addProperty")}
            </button>
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
