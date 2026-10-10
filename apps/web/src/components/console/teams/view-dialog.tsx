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
import type { CodeStep } from "./types";

export interface ViewInput {
  reason: SupportViewReason;
  reference: string;
  code?: string;
}

const KNOWN_ERRORS = [
  "support_view_off",
  "sign_in_again",
  "own_team",
  "reference_required",
  "code_required",
  "code_invalid",
  "code_void",
  "code_limit",
];

/**
 * Names a reason and a request, emails the operator a one-time code, then
 * opens the team's dashboard read-only for 30 minutes. When the code cannot
 * go out, says why and lets a recent sign-in stand in.
 */
export function ViewDialog({
  name,
  pending,
  error,
  step,
  onClose,
  onSendCode,
  onSubmit,
}: {
  name: string;
  pending: boolean;
  /** The server's refusal code, shown in the dialog's own words when it is one it knows. */
  error: string | null;
  /** What the last code request answered; null before the first. */
  step: CodeStep | null;
  onClose: () => void;
  onSendCode: () => void;
  onSubmit: (input: ViewInput) => void;
}) {
  const t = useTranslations("console.teams.viewDialog");
  const common = useTranslations("console.common");
  const id = useId();
  const [reason, setReason] = useState<SupportViewReason>("support_ticket");
  const [reference, setReference] = useState("");
  const [code, setCode] = useState("");
  const trimmed = reference.trim();
  const digits = code.replace(/\D/g, "");
  const valid =
    trimmed.length > 0 &&
    (step === null || (step.sent ? digits.length === 6 : step.signedInRecently));

  function submit() {
    if (pending || !valid) return;
    if (!step) onSendCode();
    else onSubmit({ reason, reference: trimmed, ...(step.sent ? { code: digits } : {}) });
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
        {step?.sent ? (
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor={`${id}-code`}>{t("code")}</label>
            <input
              id={`${id}-code`}
              type="text"
              className="ms-input mono"
              style={{ width: "100%" }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              // biome-ignore lint/a11y/noAutofocus: the field appears in answer to the operator's own click, and the code is the next thing to type
              autoFocus
              disabled={pending}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--ms-muted)",
                fontSize: "var(--ms-fs-label)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
              }}
            >
              {t("codeSent", { email: step.to, minutes: step.minutes })}
              <button
                type="button"
                className="ms-btn ms-btn-ghost ms-btn-sm"
                disabled={pending}
                onClick={() => {
                  setCode("");
                  onSendCode();
                }}
              >
                {t("codeResend")}
              </button>
            </p>
          </div>
        ) : step ? (
          <p
            style={{
              margin: "14px 0 0",
              color: step.signedInRecently ? "var(--ms-muted)" : "var(--ms-warn)",
              fontSize: 13,
            }}
          >
            {t(`fallback.${step.reason}`, { minutes: step.minutes })}{" "}
            {t(step.signedInRecently ? "fallback.fresh" : "fallback.stale")}
          </p>
        ) : null}
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
            {t(step ? "confirm" : "sendCode")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
