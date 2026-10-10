"use client";

import {
  SUPPORT_VIEW_REASONS,
  type SupportViewReason,
} from "@millionsend/core/support-view-reasons";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";

export interface ViewInput {
  reason: SupportViewReason;
  reference: string;
}

const KNOWN_ERRORS = [
  "support_view_off",
  "support_view_live",
  "sign_in_again",
  "own_team",
  "silent_suspension",
  "reference_required",
];

/** Names a reason and a request, then opens the team's dashboard read-only for 30 minutes. */
export function ViewDialog({
  name,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  name: string;
  pending: boolean;
  /** The server's refusal code, shown in the dialog's own words when it is one it knows. */
  error: string | null;
  onClose: () => void;
  onSubmit: (input: ViewInput) => void;
}) {
  const t = useTranslations("console.teams.viewDialog");
  const common = useTranslations("console.common");
  const id = useId();
  const [reason, setReason] = useState<SupportViewReason>("support_ticket");
  const [reference, setReference] = useState("");
  const trimmed = reference.trim();
  const valid = trimmed.length > 0;

  function submit() {
    if (pending || !valid) return;
    onSubmit({ reason, reference: trimmed });
  }

  return (
    <Modal open onClose={onClose} onConfirm={submit} title={t("title", { team: name })}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p style={{ margin: "6px 0 16px", color: "var(--ms-muted)", fontSize: 13.5 }}>
          {t("lead")}
        </p>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-reason`}>{common("reason")}</label>
          <Select
            id={`${id}-reason`}
            value={reason}
            onChange={(next) => setReason(next as SupportViewReason)}
            ariaLabel={common("reason")}
            width="100%"
            disabled={pending}
            options={SUPPORT_VIEW_REASONS.map((key) => ({
              value: key,
              label: t(`reasons.${key}`),
            }))}
          />
        </div>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-reference`}>{t("reference")}</label>
          <input
            id={`${id}-reference`}
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            maxLength={200}
            required
            disabled={pending}
            placeholder={t("referencePlaceholder")}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
        <div
          style={{
            border: "1px dashed var(--ms-line-strong)",
            borderRadius: 10,
            padding: "14px 16px",
            color: "var(--ms-muted)",
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <b style={{ color: "var(--ms-bone)", fontWeight: 600 }}>{t("hiddenTitle")}</b>
          {t("hiddenBody")}
        </div>
        {error ? (
          <p
            style={{
              margin: "12px 0 0",
              color: "var(--ms-danger)",
              fontSize: "var(--ms-fs-label)",
            }}
          >
            {KNOWN_ERRORS.includes(error) ? t(`errors.${error}`) : error}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={pending || !valid}>
            <BtnSpinner on={pending} />
            {t("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
