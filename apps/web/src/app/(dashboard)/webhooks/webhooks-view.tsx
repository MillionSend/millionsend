"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { EmptyState } from "@/components/empty-state";
import { GroupedMultiSelect } from "@/components/grouped-multi-select";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";
import {
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_META,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/lib/webhook-events";
import { WebhookStatusBadge } from "./webhook-status-badge";

/** Shared dot + human-label option list for the event picker, derived from meta. */
function useWebhookEventOptions() {
  const t = useTranslations("webhooks");
  return {
    groups: WEBHOOK_EVENT_GROUPS.map((key) => ({ key, label: t(`eventGroup.${key}`) })),
    options: WEBHOOK_EVENT_TYPES.map((value) => ({
      value,
      label: t(`eventLabel.${value}`),
      group: WEBHOOK_EVENT_META[value].group,
      adornment: (
        <span
          className="ms-dot"
          style={{ background: WEBHOOK_EVENT_META[value].dot }}
          aria-hidden="true"
        />
      ),
    })),
  };
}

/** Mirrors the loaded table: mono URL, events chip, badge, rate, time, menu. */
function WebhooksSkeleton() {
  const t = useTranslations("webhooks");
  return (
    <Table>
      <thead>
        <tr>
          <th>{t("table.url")}</th>
          <th>{t("table.events")}</th>
          <th>{t("table.status")}</th>
          <th>{t("table.successRate")}</th>
          <th>{t("table.created")}</th>
          <th className="right" aria-label={t("table.menu")} />
        </tr>
      </thead>
      <tbody>
        {[220, 180].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={56} height={13} />
            </td>
            <td>
              <SkeletonBadge />
            </td>
            <td>
              <Skeleton width={40} height={13} />
            </td>
            <td>
              <Skeleton width={72} />
            </td>
            <td className="right" />
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Shared by the create modal and the detail page's edit affordances. */
export function EventTypesPicker({
  allEvents,
  selected,
  disabled,
  id,
  onToggleAll,
  onChange,
}: {
  allEvents: boolean;
  selected: WebhookEventType[];
  disabled: boolean;
  id?: string;
  onToggleAll: (all: boolean) => void;
  onChange: (events: WebhookEventType[]) => void;
}) {
  const t = useTranslations("webhooks");
  const { groups, options } = useWebhookEventOptions();
  const summary = allEvents
    ? t("create.allEvents")
    : selected.length === 0
      ? t("create.selectPrompt")
      : t("eventsCount", { count: selected.length });
  return (
    <GroupedMultiSelect
      value={selected}
      onChange={(next) => onChange(next as WebhookEventType[])}
      options={options}
      groups={groups}
      ariaLabel={t("create.events")}
      summary={summary}
      searchPlaceholder={t("create.searchEvents")}
      noResultsLabel={t("create.noEvents")}
      allOption={{ label: t("create.allEvents"), selected: allEvents, onToggle: onToggleAll }}
      disabled={disabled}
      width="100%"
      {...(id !== undefined ? { id } : {})}
    />
  );
}

export function WebhooksView() {
  const t = useTranslations("webhooks");
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const listQuery = useQuery(trpc.webhooks.list.queryOptions());
  const webhooks = listQuery.data;

  const [createOpen, setCreateOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [allEvents, setAllEvents] = useState(true);
  const [selectedEvents, setSelectedEvents] = useState<WebhookEventType[]>([]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; url: string } | null>(null);

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });

  const createMutation = useMutation(
    trpc.webhooks.create.mutationOptions({
      onSuccess: (data) => {
        setRevealedSecret(data.secret);
        void invalidateList();
      },
    }),
  );
  const updateMutation = useMutation(
    trpc.webhooks.update.mutationOptions({ onSuccess: () => void invalidateList() }),
  );
  const deleteMutation = useMutation(
    trpc.webhooks.delete.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        void invalidateList();
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose, and a fresh
  // arrow per render would re-run it on every keystroke, stealing focus from
  // the form inputs.
  const { reset: resetCreate } = createMutation;
  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setRevealedSecret(null);
    setUrl("");
    setDescription("");
    setAllEvents(true);
    setSelectedEvents([]);
    resetCreate();
  }, [resetCreate]);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const urlValid = url.trim().startsWith("https://");
  const submittable = urlValid && (allEvents || selectedEvents.length > 0);

  return (
    <>
      <PageHeader
        title={nav("webhooks")}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            <PlusGlyph size={14} />
            {t("addWebhook")}
          </button>
        }
      />

      {listQuery.isPending ? <WebhooksSkeleton /> : null}

      {webhooks && webhooks.length === 0 ? (
        <EmptyState
          area="webhooks"
          headline={t("empty.headline")}
          body={t("empty.body")}
          cta={
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph />
              {t("addWebhook")}
            </button>
          }
        />
      ) : null}

      {webhooks && webhooks.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <th>{t("table.url")}</th>
              <th>{t("table.events")}</th>
              <th>{t("table.status")}</th>
              <th>{t("table.successRate")}</th>
              <th>{t("table.created")}</th>
              <th className="right" aria-label={t("table.menu")} />
            </tr>
          </thead>
          <tbody>
            {webhooks.map((webhook) => (
              <tr key={webhook.id}>
                <td>
                  <Link
                    href={`/webhooks/${webhook.id}`}
                    className="ms-mono"
                    style={{
                      color: "var(--ms-bone)",
                      textDecoration: "underline",
                      textUnderlineOffset: 3,
                    }}
                  >
                    {webhook.url}
                  </Link>
                </td>
                <td>
                  <span className="ms-chip">
                    {webhook.eventTypes === null || webhook.eventTypes.length === 0
                      ? t("allEvents")
                      : t("eventsCount", { count: webhook.eventTypes.length })}
                  </span>
                </td>
                <td>
                  <WebhookStatusBadge status={webhook.status} />
                </td>
                <td>
                  <span className="ms-mono">
                    {webhook.successRate === null ? "—" : `${webhook.successRate}%`}
                  </span>
                </td>
                <td>
                  <RelativeTime date={webhook.createdAt} />
                </td>
                <td className="right">
                  <PopoverMenu
                    ariaLabel={t("table.menu")}
                    items={[
                      {
                        label: webhook.enabled ? t("disable") : t("enable"),
                        onSelect: () =>
                          updateMutation.mutate({ id: webhook.id, enabled: !webhook.enabled }),
                      },
                      null,
                      {
                        label: t("delete"),
                        danger: true,
                        onSelect: () => setDeleteTarget({ id: webhook.id, url: webhook.url }),
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title={revealedSecret ? t("reveal.title") : t("create.title")}
      >
        {revealedSecret ? (
          <form
            style={{ display: "grid", gap: 12, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              closeCreate();
            }}
          >
            <div className="ms-field">
              <label htmlFor="webhook-secret">{t("reveal.secretLabel")}</label>
              <CopyChip value={revealedSecret} />
            </div>
            <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
              {t("reveal.warning")}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="ms-btn ms-btn-primary">
                {t("reveal.done")} <span className="ms-keycap">↵</span>
              </button>
            </div>
          </form>
        ) : (
          <form
            style={{ display: "grid", gap: 14, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!submittable || createMutation.isPending) return;
              const trimmedDescription = description.trim();
              createMutation.mutate({
                url: url.trim(),
                eventTypes: allEvents ? [] : selectedEvents,
                ...(trimmedDescription ? { description: trimmedDescription } : {}),
              });
            }}
          >
            <div className="ms-field">
              <label htmlFor="webhook-url">{t("create.url")}</label>
              <input
                id="webhook-url"
                className="ms-input mono"
                style={{ width: "100%" }}
                value={url}
                disabled={createMutation.isPending}
                placeholder={t("create.urlPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="webhook-description">{t("create.description")}</label>
              <input
                id="webhook-description"
                className="ms-input"
                style={{ width: "100%" }}
                value={description}
                disabled={createMutation.isPending}
                placeholder={t("create.descriptionPlaceholder")}
                autoComplete="off"
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="webhook-events">{t("create.events")}</label>
              <EventTypesPicker
                id="webhook-events"
                allEvents={allEvents}
                selected={selectedEvents}
                disabled={createMutation.isPending}
                onToggleAll={setAllEvents}
                onChange={setSelectedEvents}
              />
            </div>
            <ModalFooter>
              <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                disabled={!submittable || createMutation.isPending}
              >
                <BtnSpinner on={createMutation.isPending} />
                {t("create.submit")} <span className="ms-keycap">↵</span>
              </button>
            </ModalFooter>
          </form>
        )}
      </Modal>

      <Modal open={deleteTarget !== null} onClose={closeDelete} title={t("deleteConfirm.title")}>
        {deleteTarget ? (
          <form
            style={{ display: "grid", gap: 14, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (deleteMutation.isPending) return;
              deleteMutation.mutate({ id: deleteTarget.id });
            }}
          >
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
              {t("deleteConfirm.body", { url: deleteTarget.url })}
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
                {t("deleteConfirm.confirm")} <span className="ms-keycap">↵</span>
              </button>
            </ModalFooter>
          </form>
        ) : null}
      </Modal>
    </>
  );
}
