"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";

/** Name-and-create modal for a new audience, shared by the contacts view and
 * every audience selector's "+ Create audience" option. */
export function CreateAudienceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("audience");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const [name, setName] = useState("");
  const create = useMutation(
    trpc.audience.audiences.create.mutationOptions({
      onSuccess: ({ id }) => {
        setName("");
        onCreated(id);
      },
    }),
  );

  return (
    <Modal open={open} onClose={onClose} title={t("list.createTitle")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (create.isPending || name.trim().length === 0) return;
          create.mutate({ name: name.trim() });
        }}
      >
        <div className="ms-field">
          <label htmlFor="audience-name">{t("list.nameLabel")}</label>
          <input
            id="audience-name"
            className={`ms-input${create.isError ? " error" : ""}`}
            style={{ width: "100%" }}
            placeholder={t("list.namePlaceholder")}
            disabled={create.isPending}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {create.isError ? (
          <p
            style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}
          >
            {t("list.createError")}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={create.isPending || name.trim().length === 0}
          >
            <BtnSpinner on={create.isPending} />
            {t("list.createConfirm")} <span className="ms-keycap">↵</span>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
