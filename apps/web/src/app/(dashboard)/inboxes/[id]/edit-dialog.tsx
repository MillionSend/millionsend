"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import type { InboxDetail } from "../parts";

const KEEP = "keep";
const EXPIRY = [KEEP, "never", "1h", "24h", "7d", "30d"] as const;

/** The inbox's name, the sender name on its mail, and a new lifetime counted from now. */
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
  const [expires, setExpires] = useState<(typeof EXPIRY)[number]>(KEEP);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded on open only; a refetch while open must not overwrite what is being typed
  useEffect(() => {
    if (!open) return;
    setName(inbox.name);
    setFromName(inbox.from_name ?? "");
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
    ...(expires === KEEP ? {} : { expiresIn: expires === "never" ? null : expires }),
  };
  const submit = () => {
    if (!ready || save.isPending) return;
    if (Object.keys(patch).length === 0) close();
    else save.mutate({ id: inbox.id, ...patch });
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
            maxLength={64}
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
            maxLength={78}
            disabled={save.isPending}
            onChange={(event) => setFromName(event.target.value)}
          />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
            {t("edit.fromNameHint")}
          </p>
        </div>
        <div className="ms-field">
          <label htmlFor="inbox-edit-expires">{t("expires.label")}</label>
          <Select
            id="inbox-edit-expires"
            value={expires}
            onChange={(value) => setExpires(EXPIRY.find((e) => e === value) ?? KEEP)}
            width="100%"
            disabled={save.isPending}
            ariaLabel={t("expires.label")}
            // A shared address never keeps forever.
            options={EXPIRY.filter((value) => !(inbox.shared && value === "never")).map(
              (value) => ({
                value,
                label: value === KEEP ? t("edit.expiresKeep") : t(`expires.${value}`),
              }),
            )}
          />
        </div>
        {save.error ? (
          <div className="ms-field-error" style={{ margin: 0 }}>
            {save.error.message}
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
