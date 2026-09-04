"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { GroupedMultiSelect } from "@/components/grouped-multi-select";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { codeRichTags } from "@/lib/code-rich-tags";
import { useTRPC } from "@/lib/trpc";
import {
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_META,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/lib/webhook-events";

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

/** Shared by the create modal, the edit dialog and the detail page. */
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

const isKnownEvent = (value: string): value is WebhookEventType =>
  (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);

export interface EditableWebhook {
  id: string;
  url: string;
  description: string | null;
  /** null = every event. */
  eventTypes: string[] | null;
}

/** URL, description and events. The secret changes only through rotation. */
export function WebhookEditModal({
  webhook,
  onClose,
}: {
  webhook: EditableWebhook | null;
  onClose: () => void;
}) {
  const t = useTranslations("webhooks");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [allEvents, setAllEvents] = useState(true);
  const [selected, setSelected] = useState<WebhookEventType[]>([]);

  // The form mirrors whichever webhook is handed in, so opening it for
  // another one starts from that one's values.
  useEffect(() => {
    if (!webhook) return;
    setUrl(webhook.url);
    setDescription(webhook.description ?? "");
    const events = (webhook.eventTypes ?? []).filter(isKnownEvent);
    setAllEvents(events.length === 0);
    setSelected(events);
  }, [webhook]);

  const mutation = useMutation(
    trpc.webhooks.update.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });
        void queryClient.invalidateQueries({
          queryKey: trpc.webhooks.get.queryKey({ id: variables.id }),
        });
        onClose();
      },
    }),
  );
  // Stable identity: Modal's focus effect depends on onClose.
  const { reset } = mutation;
  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const urlValid = url.trim().startsWith("https://");
  const submittable = urlValid && (allEvents || selected.length > 0);
  const submit = () => {
    if (!webhook || !submittable || mutation.isPending) return;
    mutation.mutate({
      id: webhook.id,
      url: url.trim(),
      description: description.trim() || null,
      eventTypes: allEvents ? [] : selected,
    });
  };

  return (
    <Modal open={webhook !== null} onClose={close} onConfirm={submit} title={t("editDialog.title")}>
      <form
        style={{ display: "grid", gap: 14, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="ms-field">
          <label htmlFor="webhook-edit-url">{t("create.url")}</label>
          <input
            id="webhook-edit-url"
            className="ms-input mono"
            style={{ width: "100%" }}
            value={url}
            disabled={mutation.isPending}
            placeholder={t("create.urlPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="webhook-edit-description">{t("create.description")}</label>
          <input
            id="webhook-edit-description"
            className="ms-input"
            style={{ width: "100%" }}
            value={description}
            disabled={mutation.isPending}
            placeholder={t("create.descriptionPlaceholder")}
            autoComplete="off"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="webhook-edit-events">{t("create.events")}</label>
          <EventTypesPicker
            id="webhook-edit-events"
            allEvents={allEvents}
            selected={selected}
            disabled={mutation.isPending}
            onToggleAll={setAllEvents}
            onChange={setSelected}
          />
        </div>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={!submittable || mutation.isPending}
          >
            <BtnSpinner on={mutation.isPending} />
            {t("editDialog.submit")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/* Offered overlaps, default first: a day to roll a deploy, three for a slow
   one, an hour for a quick switch, none for a leaked secret. */
const OVERLAP_CHOICES = [24, 72, 1, 0] as const;

/** Confirm the overlap, rotate, then show the new secret once, like the create flow's reveal pane. */
export function WebhookRotateModal({
  webhook,
  onClose,
}: {
  webhook: { id: string; url: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations("webhooks");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [hours, setHours] = useState<number>(OVERLAP_CHOICES[0]);
  const [revealed, setRevealed] = useState<{ secret: string; until: Date | null } | null>(null);

  const mutation = useMutation(
    trpc.webhooks.rotateSecret.mutationOptions({
      onSuccess: (data) => {
        setRevealed({
          secret: data.secret,
          until: data.previousSecretExpiresAt ? new Date(data.previousSecretExpiresAt) : null,
        });
        void queryClient.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });
        void queryClient.invalidateQueries({
          queryKey: trpc.webhooks.get.queryKey({ id: data.id }),
        });
      },
    }),
  );
  const { reset } = mutation;
  const close = useCallback(() => {
    setRevealed(null);
    setHours(OVERLAP_CHOICES[0]);
    reset();
    onClose();
  }, [reset, onClose]);

  const submit = () => {
    if (!webhook || mutation.isPending) return;
    mutation.mutate({ id: webhook.id, overlapHours: hours });
  };

  return (
    <Modal
      open={webhook !== null}
      onClose={close}
      onConfirm={revealed ? close : submit}
      title={revealed ? t("rotate.revealTitle") : t("rotate.title")}
    >
      {revealed ? (
        <form
          style={{ display: "grid", gap: 12, marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <div>
            <div className="ms-microlabel" style={{ marginBottom: 6 }}>
              {t("reveal.secretLabel")}
            </div>
            <CopyChip value={revealed.secret} />
          </div>
          <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
            {t("reveal.warning")}
          </p>
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
            {revealed.until
              ? t("rotate.previousUntil", {
                  date: new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(revealed.until),
                })
              : t("rotate.previousDropped")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="ms-btn ms-btn-primary">
              {t("reveal.done")} <ConfirmKeycap />
            </button>
          </div>
        </form>
      ) : webhook ? (
        <form
          style={{ display: "grid", gap: 14, marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t.rich("rotate.body", { ...codeRichTags, url: webhook.url })}
          </p>
          <div className="ms-field">
            <label htmlFor="webhook-rotate-overlap">{t("rotate.overlap")}</label>
            <Select
              id="webhook-rotate-overlap"
              value={String(hours)}
              onChange={(value) => setHours(Number(value))}
              ariaLabel={t("rotate.overlap")}
              width="100%"
              disabled={mutation.isPending}
              options={OVERLAP_CHOICES.map((choice) => ({
                value: String(choice),
                label: t("rotate.overlapHours", { count: choice }),
              }))}
            />
          </div>
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={mutation.isPending}>
              <BtnSpinner on={mutation.isPending} />
              {t("rotate.confirm")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      ) : null}
    </Modal>
  );
}
