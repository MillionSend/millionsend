"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatBlock } from "@/components/stat-block";
import { formatDayTime, formatUtcTimestamp } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { type BroadcastStatus, ContentPreview, StatusPill } from "../parts";

function Microlabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
      {children}
    </div>
  );
}

export default function BroadcastDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("broadcasts");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [cancelOpen, setCancelOpen] = useState(false);

  const query = useQuery(trpc.broadcasts.get.queryOptions({ id }, { retry: false }));
  const broadcast = query.data ?? null;
  const status = broadcast?.status as BroadcastStatus | undefined;

  const cancelMutation = useMutation(
    trpc.broadcasts.cancel.mutationOptions({
      onSuccess: () => {
        setCancelOpen(false);
        queryClient.invalidateQueries(trpc.broadcasts.pathFilter());
      },
    }),
  );
  const closeCancel = useCallback(() => setCancelOpen(false), []);
  const confirmCancel = () => {
    if (!cancelMutation.isPending) cancelMutation.mutate({ id });
  };

  if (query.isError) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("detail.notFound")}
        </p>
        <Link href="/broadcasts" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("list.title")}
        </Link>
      </>
    );
  }

  const title = broadcast ? (broadcast.name ?? broadcast.subject) : null;

  return (
    <>
      {broadcast && status ? (
        <PageHeader
          breadcrumb={
            <>
              <Crumb href="/broadcasts" label={t("list.title")} />
              <CrumbEnd label={t("detail.eyebrow")} />
            </>
          }
          title={title ?? ""}
          actions={
            status === "draft" ? (
              <Link className="ms-btn ms-btn-secondary" href={`/broadcasts/${id}/edit`}>
                {t("detail.editDraft")}
              </Link>
            ) : status === "scheduled" ? (
              <button
                type="button"
                className="ms-btn ms-btn-destructive"
                onClick={() => setCancelOpen(true)}
              >
                {t("detail.cancelSend")}
              </button>
            ) : undefined
          }
        />
      ) : (
        // Mirrors the loaded PageHeader's boxes so nothing shifts on load.
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
        </div>
      )}

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "22px 28px",
          padding: "22px 0",
          borderTop: "1px solid var(--ms-line)",
        }}
      >
        <div>
          <Microlabel>{t("detail.status")}</Microlabel>
          <div style={{ marginTop: 6 }}>
            {status ? <StatusPill status={status} /> : <SkeletonBadge width={74} />}
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.targeting")}</Microlabel>
          <div style={{ fontSize: 14, marginTop: 6 }}>
            {broadcast ? (
              (broadcast.segmentName ?? t("composer.segmentNone"))
            ) : (
              <span style={{ display: "flex" }}>
                <Skeleton width={110} height="1lh" />
              </span>
            )}
          </div>
          {broadcast?.topicName ? (
            <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 4 }}>
              {t("detail.topic")}: {broadcast.topicName}
            </div>
          ) : null}
        </div>
        <div>
          <Microlabel>{broadcast?.sentAt ? t("detail.sent") : t("detail.scheduled")}</Microlabel>
          <div style={{ fontSize: 13, marginTop: 7 }}>
            {broadcast ? (
              (() => {
                const at = broadcast.sentAt ?? broadcast.scheduledAt;
                return at ? (
                  <span title={formatUtcTimestamp(at)}>{formatDayTime(at, locale)}</span>
                ) : (
                  <span style={{ color: "var(--ms-faint)" }}>—</span>
                );
              })()
            ) : (
              <span style={{ display: "flex" }}>
                <Skeleton width={140} height="1lh" />
              </span>
            )}
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.from")}</Microlabel>
          <div style={{ marginTop: 5 }}>
            {broadcast ? <CopyChip value={broadcast.from} /> : <SkeletonChip width={180} />}
          </div>
        </div>
      </div>

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          marginBottom: 26,
        }}
      >
        <StatBlock
          label={t("detail.stats.recipients")}
          value={broadcast ? nf.format(broadcast.stats.total) : null}
        />
        <StatBlock
          label={t("detail.stats.delivered")}
          value={broadcast ? nf.format(broadcast.stats.delivered) : null}
        />
        <StatBlock
          label={t("detail.stats.bounced")}
          value={broadcast ? nf.format(broadcast.stats.bounced) : null}
        />
        <StatBlock
          label={t("detail.stats.complaints")}
          value={broadcast ? nf.format(broadcast.stats.complained) : null}
        />
      </div>

      <div className="ms-microlabel">{t("detail.content")}</div>
      <div
        style={{
          marginTop: 12,
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {broadcast ? (
          broadcast.html ? (
            <ContentPreview html={broadcast.html} title={t("detail.content")} />
          ) : broadcast.text ? (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                margin: 0,
                padding: "16px 18px",
                fontFamily: "var(--ms-font-sans)",
                fontSize: "var(--ms-fs-ui)",
                lineHeight: 1.7,
              }}
            >
              {broadcast.text}
            </pre>
          ) : (
            <p
              style={{
                margin: 0,
                padding: "16px 18px",
                color: "var(--ms-muted)",
                fontSize: "var(--ms-fs-ui)",
              }}
            >
              {t("detail.noContent")}
            </p>
          )
        ) : (
          <div style={{ padding: 28, display: "flex", justifyContent: "center" }}>
            <Skeleton width={560} height={480} radius={8} />
          </div>
        )}
      </div>

      <Modal
        open={cancelOpen}
        onClose={closeCancel}
        onConfirm={confirmCancel}
        title={t("detail.cancelTitle")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirmCancel();
          }}
        >
          <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("detail.cancelBody", { name: title ?? "—" })}
          </p>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCancel}>
              {t("detail.keep")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-destructive"
              disabled={cancelMutation.isPending}
            >
              <BtnSpinner on={cancelMutation.isPending} />
              {t("detail.cancelConfirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
