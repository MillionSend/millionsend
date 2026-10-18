"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { MessageEditor } from "@/components/maily-editor/lazy";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { htmlToText } from "@/lib/html";
import {
  type CheckTone,
  firstRecipientDomain,
  type SendCheck,
  sendChecks,
} from "@/lib/send-checks";
import { useTRPC } from "@/lib/trpc";
import { type InboxDetail, nameReviewError } from "../parts";

/** How long the To field rests before its first address's domain is asked about. */
const RECIPIENT_DEBOUNCE_MS = 400;

const TONE_COLOR: Record<CheckTone, string> = {
  warn: "var(--ms-warn)",
  ok: "var(--ms-success)",
  info: "var(--ms-info)",
};

/** A new conversation from the inbox; the inbox's send rules may hold it as a draft. */
export function SendDialog({
  open,
  onClose,
  inbox,
}: {
  open: boolean;
  onClose: () => void;
  inbox: Pick<InboxDetail, "id" | "name" | "from_name" | "email_address">;
}) {
  const t = useTranslations("inboxes");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inboxId = inbox.id;
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
  const [naming, setNaming] = useState(false);
  const [fromName, setFromName] = useState("");
  const rename = useMutation(
    trpc.inboxes.update.mutationOptions({
      onSuccess: () => {
        setNaming(false);
        void queryClient.invalidateQueries({
          queryKey: trpc.inboxes.get.queryKey({ id: inboxId }),
        });
      },
    }),
  );
  const saveName = () => {
    if (fromName.trim() === "" || rename.isPending) return;
    rename.mutate({ id: inboxId, fromName: fromName.trim() });
  };
  const { reset } = send;
  const { reset: resetRename } = rename;
  const close = useCallback(() => {
    reset();
    resetRename();
    setNaming(false);
    onClose();
  }, [reset, resetRename, onClose]);
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

  const context = useQuery(
    trpc.inboxes.sendContext.queryOptions({ id: inboxId }, { enabled: open }),
  );
  const typedDomain = firstRecipientDomain(to);
  const [recipientDomain, setRecipientDomain] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setRecipientDomain(typedDomain), RECIPIENT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typedDomain]);
  const history = useQuery(
    trpc.inboxes.contactHistory.queryOptions(
      { id: inboxId, domain: recipientDomain ?? "" },
      { enabled: open && recipientDomain !== null },
    ),
  );
  const checks = sendChecks({
    subject,
    text,
    fromName: inbox.from_name,
    address: inbox.email_address,
    domain: context.data?.domain ? { ...context.data.domain, shared: context.data.shared } : null,
    recipientDomain,
    contactBefore: history.data?.seen ?? null,
  });
  const worth = checks.filter((check) => check.tone === "warn").length;
  const label = (check: SendCheck) => t(`compose.checks.${check.key}.label`, check.params);
  const domainRow = checks.find((check) => check.key.startsWith("domain"));
  const rows =
    worth === 0
      ? [
          {
            key: "allGood",
            tone: "ok" as const,
            text: t("compose.checks.allGood", { auth: domainRow ? label(domainRow) : "" }),
            hint: null,
          },
        ]
      : checks.map((check) => ({
          key: check.key,
          tone: check.tone,
          text: label(check),
          hint: t.has(`compose.checks.${check.key}.hint`)
            ? t(`compose.checks.${check.key}.hint`, check.params)
            : null,
        }));

  return (
    <Modal open={open} onClose={close} onConfirm={submit} title={t("sendEmail")}>
      <form
        style={{ display: "grid", gap: 14, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <p className="ms-mono" style={{ margin: 0, fontSize: 12.5, color: "var(--ms-muted)" }}>
            {inbox.from_name ? (
              t.rich("compose.fromNamed", {
                fromName: inbox.from_name,
                address: inbox.email_address,
                name: (chunks) => (
                  <span style={{ color: "var(--ms-bone)", fontFamily: "var(--ms-font-sans)" }}>
                    {chunks}
                  </span>
                ),
              })
            ) : (
              <>
                {t("compose.from", { address: inbox.email_address })}
                {naming ? null : (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="ms-link"
                      style={{
                        font: "inherit",
                        background: "none",
                        border: 0,
                        padding: 0,
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        setFromName(inbox.name);
                        setNaming(true);
                      }}
                    >
                      {t("compose.setSenderName")}
                    </button>
                  </>
                )}
              </>
            )}
          </p>
          {naming ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="ms-input"
                style={{ flex: 1, minWidth: 0 }}
                // biome-ignore lint/a11y/noAutofocus: the field appears on the click that asked for it
                autoFocus
                aria-label={t("edit.fromName")}
                value={fromName}
                maxLength={78}
                disabled={rename.isPending}
                onChange={(event) => setFromName(event.target.value)}
                // Enter here saves the name; the form around it would send the mail.
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveName();
                  }
                }}
              />
              <button
                type="button"
                className="ms-btn ms-btn-sm ms-btn-secondary"
                disabled={fromName.trim() === "" || rename.isPending}
                onClick={saveName}
              >
                <BtnSpinner on={rename.isPending} />
                {t("edit.save")}
              </button>
            </div>
          ) : null}
          {rename.error ? (
            <div className="ms-field-error" style={{ margin: 0 }}>
              {nameReviewError(t, rename.error)?.text ?? rename.error.message}
            </div>
          ) : null}
        </div>
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
        <div
          style={{
            border: "1px solid var(--ms-line)",
            borderRadius: "var(--ms-r-input)",
            padding: "10px 12px",
            display: "grid",
            gap: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: "var(--ms-fs-badge)",
              color: "var(--ms-muted)",
            }}
          >
            <span>{t("compose.checks.title")}</span>
            <span className="ms-mono" style={{ color: "var(--ms-faint)" }}>
              {t("compose.checks.count", { n: worth, total: checks.length })}
            </span>
          </div>
          {rows.map((row) => (
            <div
              key={row.key}
              style={{ display: "flex", gap: 8, fontSize: "var(--ms-fs-label)", lineHeight: 1.4 }}
            >
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 7,
                  height: 7,
                  marginTop: 6,
                  borderRadius: "50%",
                  background: TONE_COLOR[row.tone],
                }}
              />
              <span style={{ color: "var(--ms-bone)" }}>
                {row.text}
                {row.hint ? <span style={{ color: "var(--ms-muted)" }}> {row.hint}</span> : null}
              </span>
            </div>
          ))}
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
