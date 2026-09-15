"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";

export const PAUSE_REASONS = ["complaints", "report", "manual"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export const SUSPENSION_REASONS = ["phishing", "reputation", "non_payment", "manual"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export interface HoldInput<R extends string> {
  reason: R;
  note?: string;
  notify: boolean;
}

function CancelButton({ onClose }: { onClose: () => void }) {
  const common = useTranslations("console.common");
  return (
    <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
      {common("cancel")} <span className="ms-keycap">Esc</span>
    </button>
  );
}

function NotifyRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13 }}
    >
      <input
        id={id}
        type="checkbox"
        className="ms-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** Broadcasts park until an operator resumes them; the owner may be told why. */
export function PauseDialog({
  name,
  pending,
  onClose,
  onSubmit,
}: {
  name: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: HoldInput<PauseReason>) => void;
}) {
  const t = useTranslations("console.teams.pauseDialog");
  const common = useTranslations("console.common");
  const id = useId();
  const [reason, setReason] = useState<PauseReason>("complaints");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);

  function submit() {
    if (pending) return;
    const trimmed = note.trim();
    onSubmit({ reason, ...(trimmed ? { note: trimmed } : {}), notify });
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
            onChange={(next) => setReason(next as PauseReason)}
            ariaLabel={common("reason")}
            width="100%"
            disabled={pending}
            options={PAUSE_REASONS.map((key) => ({ value: key, label: t(`reasons.${key}`) }))}
          />
        </div>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-note`}>{t("noteLabel")}</label>
          <textarea
            id={`${id}-note`}
            className="ms-input"
            style={{ width: "100%", minHeight: 72, resize: "vertical" }}
            maxLength={1000}
            disabled={pending}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <NotifyRow
          id={`${id}-notify`}
          label={t("notify")}
          checked={notify}
          disabled={pending}
          onChange={setNotify}
        />
        <ModalFooter>
          <CancelButton onClose={onClose} />
          <button type="submit" className="ms-btn ms-btn-destructive" disabled={pending}>
            <BtnSpinner on={pending} />
            {t("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Every send refused until reinstated. A phishing suspension never emails the owner. */
export function SuspendDialog({
  name,
  pending,
  onClose,
  onSubmit,
}: {
  name: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: HoldInput<SuspensionReason>) => void;
}) {
  const t = useTranslations("console.teams.suspendDialog");
  const common = useTranslations("console.common");
  const id = useId();
  const [reason, setReason] = useState<SuspensionReason>("reputation");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const phishing = reason === "phishing";

  function submit() {
    if (pending) return;
    const trimmed = note.trim();
    onSubmit({ reason, ...(trimmed ? { note: trimmed } : {}), notify: notify && !phishing });
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
          <label htmlFor={`${id}-${SUSPENSION_REASONS[0]}`}>{common("reason")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {SUSPENSION_REASONS.map((key) => (
              <label key={key} className="ms-radio-card">
                <input
                  id={`${id}-${key}`}
                  type="radio"
                  name={`${id}-reason`}
                  checked={reason === key}
                  disabled={pending}
                  onChange={() => setReason(key)}
                />
                <span>
                  {t(`reasons.${key}`)}
                  {t.has(`reasons.${key}Sub`) ? (
                    <div className="sub">{t(`reasons.${key}Sub`)}</div>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-note`}>{common("note")}</label>
          <textarea
            id={`${id}-note`}
            className="ms-input"
            style={{ width: "100%", minHeight: 72, resize: "vertical" }}
            maxLength={1000}
            placeholder={t("notePlaceholder")}
            disabled={pending}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {phishing ? null : (
          <NotifyRow
            id={`${id}-notify`}
            label={common("notifyOwner")}
            checked={notify}
            disabled={pending}
            onChange={setNotify}
          />
        )}
        <ModalFooter>
          <CancelButton onClose={onClose} />
          <button type="submit" className="ms-btn ms-btn-destructive" disabled={pending}>
            <BtnSpinner on={pending} />
            {t("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function ReinstateDialog({
  name,
  pending,
  onClose,
  onSubmit,
}: {
  name: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("console.teams.reinstateDialog");
  function submit() {
    if (!pending) onSubmit();
  }
  return (
    <Modal open onClose={onClose} onConfirm={submit} title={t("title", { team: name })}>
      <p style={{ margin: "6px 0 0", color: "var(--ms-muted)", fontSize: 13.5, lineHeight: 1.6 }}>
        {t("lead")}
      </p>
      <ModalFooter>
        <CancelButton onClose={onClose} />
        <button type="button" className="ms-btn ms-btn-primary" disabled={pending} onClick={submit}>
          <BtnSpinner on={pending} />
          {t("confirm")} <ConfirmKeycap />
        </button>
      </ModalFooter>
    </Modal>
  );
}
