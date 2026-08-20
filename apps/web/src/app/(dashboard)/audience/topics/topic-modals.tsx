"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { Tooltip } from "@/components/tooltip";
import { useTRPC } from "@/lib/trpc";

export type TopicEditTarget = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  defaultSubscribed: boolean;
};

/** Edit-topic dialog shared by the topics list and the topic detail page. */
export function TopicEditModal({
  target,
  onClose,
}: {
  target: TopicEditTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations("audience.topics");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Edits accumulate here; the prop stays the pristine seed until reopened.
  const [draft, setDraft] = useState<TopicEditTarget | null>(null);

  // Stable identity: Modal's focus effect depends on onClose.
  const close = useCallback(() => {
    setDraft(null);
    onClose();
  }, [onClose]);

  const updateMutation = useMutation(
    trpc.topics.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.topics.pathFilter());
        close();
      },
    }),
  );

  const form = draft ?? target;
  const set = (patch: Partial<TopicEditTarget>) => {
    if (form) setDraft({ ...form, ...patch });
  };
  const submit = () => {
    if (!form || updateMutation.isPending || form.name.trim().length === 0) return;
    updateMutation.mutate({
      id: form.id,
      name: form.name.trim(),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      visibility: form.visibility,
    });
  };

  return (
    <Modal open={target !== null} onClose={close} onConfirm={submit} title={t("editTitle")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="ms-field">
          <label htmlFor="topic-edit-name">{t("nameLabel")}</label>
          <input
            id="topic-edit-name"
            className={`ms-input${updateMutation.isError ? " error" : ""}`}
            style={{ width: "100%" }}
            placeholder={t("namePlaceholder")}
            disabled={updateMutation.isPending}
            value={form?.name ?? ""}
            onChange={(event) => set({ name: event.target.value })}
          />
        </div>
        <div className="ms-field" style={{ marginTop: 14 }}>
          <label htmlFor="topic-edit-description">{t("descriptionLabel")}</label>
          <input
            id="topic-edit-description"
            className="ms-input"
            style={{ width: "100%" }}
            placeholder={t("descriptionPlaceholder")}
            disabled={updateMutation.isPending}
            value={form?.description ?? ""}
            onChange={(event) => set({ description: event.target.value })}
          />
        </div>
        <div className="ms-field" style={{ marginTop: 14 }}>
          <div className="ms-label-row">
            <label htmlFor="topic-edit-visibility">{t("visibilityLabel")}</label>
            <Tooltip text={t("visibilityTooltip")} />
          </div>
          <Select
            id="topic-edit-visibility"
            value={form?.visibility ?? "private"}
            onChange={(value) => set({ visibility: value === "public" ? "public" : "private" })}
            ariaLabel={t("visibilityLabel")}
            width="100%"
            disabled={updateMutation.isPending}
            options={[
              { value: "private", label: t("visibilityPrivate") },
              { value: "public", label: t("visibilityPublic") },
            ]}
          />
        </div>
        <div className="ms-field" style={{ marginTop: 14 }}>
          <label htmlFor="topic-edit-default">{t("defaultLabel")}</label>
          <Select
            id="topic-edit-default"
            value={form?.defaultSubscribed === false ? "opt_out" : "opt_in"}
            onChange={() => {}}
            ariaLabel={t("defaultLabel")}
            width="100%"
            disabled
            options={[
              { value: "opt_in", label: t("defaultOptIn") },
              { value: "opt_out", label: t("defaultOptOut") },
            ]}
          />
          <p
            style={{
              margin: "6px 0 0",
              color: "var(--ms-faint)",
              fontSize: "var(--ms-fs-label)",
            }}
          >
            {t("defaultImmutable")}
          </p>
        </div>
        {updateMutation.isError ? <p className="ms-field-error">{t("editError")}</p> : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={updateMutation.isPending || (form?.name.trim().length ?? 0) === 0}
          >
            <BtnSpinner on={updateMutation.isPending} />
            {t("editConfirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Delete-topic dialog shared by the topics list and the topic detail page. */
export function TopicDeleteModal({
  target,
  onClose,
  onDeleted,
}: {
  target: { id: string; name: string } | null;
  onClose: () => void;
  /** After the delete lands (the detail page navigates back to the list). */
  onDeleted?: () => void;
}) {
  const t = useTranslations("audience.topics");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation(
    trpc.topics.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.topics.pathFilter());
        onClose();
        onDeleted?.();
      },
    }),
  );

  const submit = () => {
    if (target && !deleteMutation.isPending) deleteMutation.mutate({ id: target.id });
  };

  return (
    <Modal open={target !== null} onClose={onClose} onConfirm={submit} title={t("deleteTitle")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("deleteBody", { name: target?.name ?? "—" })}
        </p>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-destructive"
            disabled={deleteMutation.isPending}
          >
            <BtnSpinner on={deleteMutation.isPending} />
            {t("deleteConfirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
