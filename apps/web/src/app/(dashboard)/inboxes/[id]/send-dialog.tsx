"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { MessageEditor } from "@/components/maily-editor/lazy";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { htmlToText } from "@/lib/html";
import { useTRPC } from "@/lib/trpc";

/** A new conversation from the inbox; the inbox's send rules may hold it as a draft. */
export function SendDialog({
  open,
  onClose,
  inboxId,
  from,
}: {
  open: boolean;
  onClose: () => void;
  inboxId: string;
  from: string;
}) {
  const t = useTranslations("inboxes");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  // The editor seeds from it on mount: the Modal unmounts it on close, so a
  // reopen shows what was typed and a send leaves it empty.
  const [html, setHtml] = useState("");
  const send = useMutation(
    trpc.inboxes.send.mutationOptions({
      onSuccess: (result) => {
        toast(result.kind === "sent" ? t("compose.sent") : t("compose.drafted"));
        void queryClient.invalidateQueries({ queryKey: trpc.inboxes.pathKey() });
        setTo("");
        setSubject("");
        setHtml("");
        onClose();
      },
    }),
  );
  const { reset } = send;
  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);
  const recipients = to
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const text = htmlToText(html);
  const ready = recipients.length > 0 && subject.trim() !== "" && text !== "";
  const submit = () => {
    if (!ready || send.isPending) return;
    send.mutate({ inboxId, to: recipients, subject: subject.trim(), html, text });
  };
  return (
    <Modal open={open} onClose={close} onConfirm={submit} title={t("sendEmail")}>
      <form
        style={{ display: "grid", gap: 14, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="ms-mono" style={{ margin: 0, fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("compose.from", { address: from })}
        </p>
        <div className="ms-field">
          <label htmlFor="send-to">{t("compose.to")}</label>
          <input
            id="send-to"
            className="ms-input mono"
            style={{ width: "100%" }}
            value={to}
            disabled={send.isPending}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="send-subject">{t("compose.subject")}</label>
          <input
            id="send-subject"
            className="ms-input"
            style={{ width: "100%" }}
            value={subject}
            maxLength={2000}
            disabled={send.isPending}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className="ms-field">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: a caption; the editor below carries the same name, and a contenteditable can't be a label's control */}
          <label>{t("compose.message")}</label>
          <MessageEditor
            value={{ document: null, html }}
            compact={{
              placeholder: t("compose.messagePlaceholder"),
              ariaLabel: t("compose.message"),
              onSubmit: submit,
            }}
            onChange={(change) => setHtml(change.html ?? "")}
          />
        </div>
        {send.error ? (
          <div className="ms-field-error" style={{ margin: 0 }}>
            {send.error.message}
          </div>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={!ready || send.isPending}
          >
            <BtnSpinner on={send.isPending} />
            {t("compose.send")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
