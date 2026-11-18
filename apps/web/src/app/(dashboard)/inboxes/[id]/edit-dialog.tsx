"use client";

import { FROM_NAME_MAX, INBOX_NAME_MAX } from "@millionsend/core/inbox-username";
import { REPLY_FROM_NAMES, teammateNames } from "@millionsend/core/reply-from-rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import { type InboxDetail, nameReviewError, type ReplyFromMode } from "../parts";

const KEEP = "keep";
const EXPIRY = [KEEP, "never", "1h", "24h", "7d", "30d"] as const;

/** The inbox's name, the sender name on its mail, how teammates' sends are named, and a new lifetime counted from now. */
export function EditDialog({
  inbox,
  open,
  onClose,
}: {
  inbox: InboxDetail;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("inboxes");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState(inbox.name);
  const [fromName, setFromName] = useState(inbox.from_name ?? "");
  const [replyFrom, setReplyFrom] = useState(inbox.reply_from_name);
  const [expires, setExpires] = useState<(typeof EXPIRY)[number]>(KEEP);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded on open only; a refetch while open must not overwrite what is being typed
  useEffect(() => {
    if (!open) return;
    setName(inbox.name);
    setFromName(inbox.from_name ?? "");
    setReplyFrom(inbox.reply_from_name);
    setExpires(KEEP);
  }, [open]);
  const save = useMutation(
    trpc.inboxes.update.mutationOptions({
      onSuccess: () => {
        toast(t("edit.saved"));
        void queryClient.invalidateQueries({ queryKey: trpc.inboxes.pathKey() });
        onClose();
      },
    }),
  );
  const { reset } = save;
  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);
  const ready = name.trim() !== "";
  // Only what changed goes out: an untouched field keeps what is stored.
  const patch = {
    ...(name.trim() !== inbox.name ? { name: name.trim() } : {}),
    ...(fromName.trim() !== (inbox.from_name ?? "") ? { fromName: fromName.trim() } : {}),
    ...(replyFrom !== inbox.reply_from_name ? { replyFromName: replyFrom } : {}),
    ...(expires === KEEP ? {} : { expiresIn: expires === "never" ? null : expires }),
  };
  const submit = () => {
    if (!ready || save.isPending) return;
    if (Object.keys(patch).length === 0) close();
    else save.mutate({ id: inbox.id, ...patch });
  };
  // The examples follow the sender name as typed.
  const sender = fromName.trim() || null;
  const names = teammateNames(sender, inbox.reply_from?.teammate);
  const example = (mode: ReplyFromMode) => {
    const named = names ? names[mode] : sender;
    return named ? `${named} <${inbox.email_address}>` : inbox.email_address;
  };
  return (
    <Modal open={open} onClose={close} onConfirm={submit} title={t("edit.title")}>
      <form
        style={{ display: "grid", gap: 14, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="ms-field">
          <label htmlFor="inbox-edit-name">{t("create.name")}</label>
          <input
            id="inbox-edit-name"
            className="ms-input"
            style={{ width: "100%" }}
            value={name}
            maxLength={INBOX_NAME_MAX}
            disabled={save.isPending}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="inbox-edit-from">{t("edit.fromName")}</label>
          <input
            id="inbox-edit-from"
            className="ms-input"
            style={{ width: "100%" }}
            value={fromName}
            maxLength={FROM_NAME_MAX}
            disabled={save.isPending}
            onChange={(event) => setFromName(event.target.value)}
          />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
            {t("edit.fromNameHint")}
          </p>
        </div>
        {/* The shared domain always sends as the sender name. */}
        {inbox.shared ? null : (
          <fieldset className="ms-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{t("edit.replyFrom.legend")}</legend>
            <div style={{ display: "grid", gap: 6 }}>
              {REPLY_FROM_NAMES.map((mode) => (
                <label key={mode} className="ms-radio-card">
                  <input
                    type="radio"
                    name="inbox-reply-name"
                    checked={replyFrom === mode}
                    disabled={save.isPending}
                    onChange={() => setReplyFrom(mode)}
                  />
                  <span>
                    {t(`edit.replyFrom.${mode}`)}
                    <div className="sub">
                      <span className="ms-mono">{example(mode)}</span>
                    </div>
                  </span>
                </label>
              ))}
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
              {t("edit.replyFrom.hint")}
            </p>
          </fieldset>
        )}
        <div className="ms-field">
          <label htmlFor="inbox-edit-expires">{t("expires.label")}</label>
          <Select
            id="inbox-edit-expires"
            value={expires}
            onChange={(value) => setExpires(EXPIRY.find((e) => e === value) ?? KEEP)}
            width="100%"
            disabled={save.isPending}
            ariaLabel={t("expires.label")}
            options={EXPIRY.map((value) => ({
              value,
              label: value === KEEP ? t("edit.expiresKeep") : t(`expires.${value}`),
            }))}
          />
        </div>
        {save.error ? (
          <div className="ms-field-error" style={{ margin: 0 }}>
            {nameReviewError(t, save.error)?.text ?? save.error.message}
          </div>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={!ready || save.isPending}
          >
            <BtnSpinner on={save.isPending} />
            {t("edit.save")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
