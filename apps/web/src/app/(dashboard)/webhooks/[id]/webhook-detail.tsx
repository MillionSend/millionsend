"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment, useCallback, useState } from "react";
import { confirmDialog } from "@/components/confirm-dialog";
import { CopyChip } from "@/components/copy-chip";
import { LoadError } from "@/components/load-error";
import { MetaItem } from "@/components/meta-item";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { codeRichTags } from "@/lib/code-rich-tags";
import { displayUrl } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { maskWebhookSecret, WEBHOOK_EVENT_META, type WebhookEventType } from "@/lib/webhook-events";
import { ListFooter, PAGE_SIZES } from "../../emails/list-parts";
import { DeliveryStatusBadge, WebhookStatusBadge } from "../webhook-status-badge";

function DeliveriesTableHead() {
  const t = useTranslations("webhooks");
  return (
    <thead>
      <tr>
        <th>{t("deliveryTable.event")}</th>
        <th>{t("deliveryTable.status")}</th>
        <th>{t("deliveryTable.response")}</th>
        <th>{t("deliveryTable.attempts")}</th>
        <th>{t("deliveryTable.time")}</th>
      </tr>
    </thead>
  );
}

/** Mirrors the loaded deliveries ledger: mono event, badge, code, digits, time. */
function DeliveriesSkeleton() {
  return (
    <Table>
      <DeliveriesTableHead />
      <tbody>
        {[130, 110, 130].map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <tr key={index}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <SkeletonBadge />
            </td>
            <td>
              <Skeleton width={32} height={13} />
            </td>
            <td>
              <Skeleton width={16} height={13} />
            </td>
            <td>
              <Skeleton width={72} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Expanded row body: payload JSON plus whatever response was recorded. */
function DeliveryExpanded({ id }: { id: string }) {
  const t = useTranslations("webhooks");
  const trpc = useTRPC();
  const delivery = useQuery(trpc.webhooks.deliveries.get.queryOptions({ id }));

  if (delivery.isPending) {
    // Mirrors the loaded expanded row (payload block, response, message id).
    return (
      <div style={{ display: "grid", gap: 12, padding: "4px 0 8px" }}>
        <div>
          <p className="ms-microlabel" style={{ margin: "0 0 6px", fontSize: 10.5 }}>
            {t("detail.payload")}
          </p>
          <div
            className="ms-mono"
            style={{
              padding: 12,
              fontSize: 11.5,
              lineHeight: 1.6,
              background: "var(--ms-ground)",
              border: "1px solid var(--ms-line)",
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
            }}
          >
            {[64, 220, 180, 96].map((width, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines, position is identity
              <span key={index} style={{ display: "flex" }}>
                <Skeleton width={width} height="1lh" />
              </span>
            ))}
          </div>
        </div>
        <div>
          <p className="ms-microlabel" style={{ margin: "0 0 6px", fontSize: 10.5 }}>
            {t("detail.response")}
          </p>
          <div className="ms-mono" style={{ fontSize: 11.5, lineHeight: 1.6, display: "flex" }}>
            <Skeleton width={40} height="1lh" />
          </div>
        </div>
        <div className="ms-mono" style={{ fontSize: 11, display: "flex" }}>
          <Skeleton width={260} height="1lh" />
        </div>
      </div>
    );
  }
  if (delivery.isError) {
    return (
      <p style={{ margin: 0, fontSize: "var(--ms-fs-label)", color: "var(--ms-muted)" }}>
        {t("detail.deliveriesError")}
      </p>
    );
  }
  const data = delivery.data;
  return (
    <div style={{ display: "grid", gap: 12, padding: "4px 0 8px" }}>
      <div>
        <p className="ms-microlabel" style={{ margin: "0 0 6px", fontSize: 10.5 }}>
          {t("detail.payload")}
        </p>
        <pre
          className="ms-mono"
          style={{
            margin: 0,
            padding: 12,
            fontSize: 11.5,
            lineHeight: 1.6,
            background: "var(--ms-ground)",
            border: "1px solid var(--ms-line)",
            borderRadius: 8,
            // A long diagnostic string wraps here rather than widening the
            // whole deliveries table into a horizontal scroll.
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {JSON.stringify(data.payload, null, 2)}
        </pre>
      </div>
      <div>
        <p className="ms-microlabel" style={{ margin: "0 0 6px", fontSize: 10.5 }}>
          {t("detail.response")}
        </p>
        {data.lastResponseCode !== null || data.lastResponseBody ? (
          <div className="ms-mono" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            {data.lastResponseCode !== null ? <div>{data.lastResponseCode}</div> : null}
            {data.lastResponseBody ? (
              <div style={{ color: "var(--ms-muted)", whiteSpace: "pre-wrap" }}>
                {data.lastResponseBody}
              </div>
            ) : null}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "var(--ms-fs-label)", color: "var(--ms-muted)" }}>
            {t("detail.noResponse")}
          </p>
        )}
      </div>
      <div className="ms-mono" style={{ fontSize: 11, color: "var(--ms-muted)" }}>
        {t("detail.messageId")}: {data.messageId}
      </div>
    </div>
  );
}

export function WebhookDetail({ id }: { id: string }) {
  const t = useTranslations("webhooks");
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [testError, setTestError] = useState<"testRateLimited" | "testFailed" | null>(null);

  const webhook = useQuery(trpc.webhooks.get.queryOptions({ id }));
  const deliveriesInput = { endpointId: id, offset: page * pageSize, limit: pageSize };
  const deliveries = useQuery(
    trpc.webhooks.deliveries.list.queryOptions(deliveriesInput, { enabled: webhook.isSuccess }),
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.webhooks.get.queryKey({ id }) });
    void queryClient.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });
  };
  const updateMutation = useMutation(
    trpc.webhooks.update.mutationOptions({ onSuccess: invalidate }),
  );
  const deleteMutation = useMutation(
    trpc.webhooks.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });
        router.push("/webhooks");
      },
    }),
  );
  const testMutation = useMutation(
    trpc.webhooks.testDelivery.mutationOptions({
      onSuccess: () => {
        setTestSent(true);
        setTestError(null);
        void queryClient.invalidateQueries({
          queryKey: trpc.webhooks.deliveries.list.queryKey(),
        });
      },
      onError: (error) => {
        setTestSent(false);
        setTestError(error.data?.code === "TOO_MANY_REQUESTS" ? "testRateLimited" : "testFailed");
      },
    }),
  );

  // Stable identity: Modal-style focus/keyboard effects depend on onClose.
  const closeDelete = useCallback(() => setConfirmingDelete(false), []);

  // Shared by the form's onSubmit and the modal's ⌘↵ onConfirm, with the same
  // guard as the primary button's disabled state.
  const submitDelete = () => {
    if (deleteMutation.isPending) return;
    deleteMutation.mutate({ id });
  };
  // Disabling silently drops live traffic, so it confirms; enabling is direct.
  const toggleEnabled = async (webhook: { url: string; enabled: boolean }) => {
    if (webhook.enabled) {
      const ok = await confirmDialog({
        title: t("disableConfirm.title"),
        message: t("disableConfirm.body", { url: webhook.url }),
        confirmLabel: t("disableConfirm.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    updateMutation.mutate({ id, enabled: !webhook.enabled });
  };

  if (webhook.isError) {
    return (
      <LoadError
        error={webhook.error}
        headline={t("detail.error")}
        notFoundHeadline={t("detail.notFound")}
        onRetry={() => webhook.refetch()}
        backHref="/webhooks"
        backLabel={nav("webhooks")}
      />
    );
  }

  if (!webhook.isSuccess) {
    // Mirrors the loaded page's containers exactly (breadcrumb + H1, meta
    // strip, deliveries ledger) so nothing shifts when data lands.
    return (
      <>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
            <Skeleton width={140} height="1lh" />
          </div>
          <h1
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", margin: 0, display: "flex" }}
          >
            <Skeleton width={320} height="1lh" />
          </h1>
        </div>
        <div
          className="ms-meta-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 28,
            padding: "20px 0",
            borderTop: "1px solid var(--ms-line)",
            borderBottom: "1px solid var(--ms-line)",
            maxWidth: 1000,
          }}
        >
          <MetaItem label={t("detail.url")}>
            <Skeleton width={220} height={14} />
          </MetaItem>
          <MetaItem label={t("detail.signingSecret")}>
            <Skeleton width={160} height={14} />
          </MetaItem>
          <MetaItem label={t("detail.events")}>
            <Skeleton width={120} height={14} />
          </MetaItem>
          <MetaItem label={t("detail.status")}>
            <SkeletonBadge />
          </MetaItem>
          <MetaItem label={t("detail.created")}>
            <Skeleton width={110} height={14} />
          </MetaItem>
        </div>
        <section style={{ marginTop: 26, maxWidth: 1000 }}>
          <h2 className="ms-display" style={{ fontSize: 22, margin: 0, display: "flex" }}>
            <Skeleton width={140} height="1lh" />
          </h2>
          <div style={{ marginTop: 22 }}>
            <DeliveriesSkeleton />
          </div>
        </section>
      </>
    );
  }

  const data = webhook.data;
  const total = deliveries.data?.total ?? 0;
  const pageItems = deliveries.data?.items ?? [];
  const lastPage = (page + 1) * pageSize >= total;

  return (
    <>
      <PageHeader
        title={displayUrl(data.url)}
        breadcrumb={
          <>
            <Crumb href="/webhooks" label={nav("webhooks")} />
            <CrumbEnd label={t("detail.eyebrow")} />
          </>
        }
        actions={
          <>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={testMutation.isPending}
                onClick={() => testMutation.mutate({ id })}
              >
                <BtnSpinner on={testMutation.isPending} />
                {t("detail.sendTest")}
              </button>
              {testSent || testError ? (
                <span
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: 0,
                    whiteSpace: "nowrap",
                    color: testError ? "var(--ms-danger)" : "var(--ms-muted)",
                    fontSize: "var(--ms-fs-label)",
                  }}
                >
                  {testError ? t(`detail.${testError}`) : `✓ ${t("detail.testQueued")}`}
                </span>
              ) : null}
            </div>
            <PopoverMenu
              boxed
              ariaLabel={t("detail.moreActions")}
              items={[
                {
                  label: data.enabled ? t("disable") : t("enable"),
                  onSelect: () => void toggleEnabled(data),
                },
                null,
                {
                  label: t("delete"),
                  danger: true,
                  onSelect: () => setConfirmingDelete(true),
                },
              ]}
            />
          </>
        }
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 28,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          maxWidth: 1000,
        }}
      >
        <MetaItem label={t("detail.url")}>
          <CopyChip value={data.url} display={displayUrl(data.url)} />
        </MetaItem>
        <MetaItem label={t("detail.signingSecret")}>
          <span className="ms-mono">{maskWebhookSecret(data.secretLast4)}</span>
        </MetaItem>
        {/* The chip list is the one tall cell: it spans both rows so Status
            and Created stay under URL and Secret instead of below it. */}
        <div className="ms-meta-tall">
          <MetaItem label={t("detail.events")}>
            {data.eventTypes === null ? (
              <span className="ms-chip">{t("allEvents")}</span>
            ) : (
              <div className="ms-wrap-row" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {data.eventTypes.map((eventType) => {
                  const meta = WEBHOOK_EVENT_META[eventType as WebhookEventType] as
                    | { dot: string }
                    | undefined;
                  return (
                    <span
                      key={eventType}
                      className="ms-chip"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      {meta ? (
                        <span
                          className="ms-dot"
                          style={{ background: meta.dot }}
                          aria-hidden="true"
                        />
                      ) : null}
                      {meta ? t(`eventLabel.${eventType}`) : eventType}
                    </span>
                  );
                })}
              </div>
            )}
          </MetaItem>
        </div>
        <MetaItem label={t("detail.status")}>
          <WebhookStatusBadge status={data.status} />
        </MetaItem>
        <MetaItem label={t("detail.created")}>
          <RelativeTime date={data.createdAt} />
        </MetaItem>
        {data.description ? (
          <MetaItem label={t("detail.description")}>{data.description}</MetaItem>
        ) : null}
      </div>

      <section style={{ marginTop: 26, maxWidth: 1000 }}>
        <h2 className="ms-display" style={{ fontSize: 22, margin: 0, color: "var(--ms-bone)" }}>
          {t("detail.deliveries")}
        </h2>
        <div style={{ marginTop: 22 }}>
          {deliveries.isError ? (
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)" }}>
                {t("detail.deliveriesError")}
              </p>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => deliveries.refetch()}
              >
                {t("detail.retry")}
              </button>
            </div>
          ) : !deliveries.isSuccess ? (
            <DeliveriesSkeleton />
          ) : total === 0 ? (
            <p style={{ margin: 0, fontSize: "var(--ms-fs-ui)", color: "var(--ms-muted)" }}>
              {t("detail.noDeliveries")}
            </p>
          ) : (
            <>
              <Table>
                <DeliveriesTableHead />
                <tbody>
                  {pageItems.map((delivery) => (
                    <Fragment key={delivery.id}>
                      <tr
                        onClick={() =>
                          setExpandedId(expandedId === delivery.id ? null : delivery.id)
                        }
                        style={{ cursor: "pointer" }}
                        aria-expanded={expandedId === delivery.id}
                      >
                        <td>
                          <span className="ms-mono">{delivery.eventType}</span>
                        </td>
                        <td>
                          <DeliveryStatusBadge status={delivery.status} />
                        </td>
                        <td>
                          <span className="ms-mono">{delivery.lastResponseCode ?? "—"}</span>
                        </td>
                        <td>
                          <span className="ms-mono">{delivery.attempts}</span>
                        </td>
                        <td>
                          <RelativeTime date={delivery.createdAt} />
                        </td>
                      </tr>
                      {expandedId === delivery.id ? (
                        <tr>
                          <td colSpan={5}>
                            <DeliveryExpanded id={delivery.id} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </Table>
              {total > pageSize ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    disabled={page === 0}
                    onClick={() => {
                      setExpandedId(null);
                      setPage((p) => Math.max(0, p - 1));
                    }}
                  >
                    {t("detail.prev")}
                  </button>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    disabled={lastPage}
                    onClick={() => {
                      setExpandedId(null);
                      setPage((p) => p + 1);
                    }}
                  >
                    {t("detail.next")}
                  </button>
                </div>
              ) : null}
              <ListFooter
                left={t("detail.pageOf", {
                  from: page * pageSize + 1,
                  to: Math.min((page + 1) * pageSize, total),
                  total,
                })}
                size={pageSize}
                onSize={(next) => {
                  setExpandedId(null);
                  setPage(0);
                  setPageSize(next);
                }}
                sizeLabel={(size) => t("pageSize", { count: size })}
                singlePage={page === 0 && total <= pageSize}
              />
            </>
          )}
        </div>
      </section>

      <Modal
        open={confirmingDelete}
        onClose={closeDelete}
        onConfirm={submitDelete}
        title={t("deleteConfirm.title")}
      >
        <form
          style={{ display: "grid", gap: 14, marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            submitDelete();
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t.rich("deleteConfirm.body", { ...codeRichTags, url: data.url })}
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
              {t("deleteConfirm.confirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
