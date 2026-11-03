"use client";

import {
  PAUSE_LIFT_COOLDOWN_DAYS,
  PAUSE_WINDOW_DAYS,
  type PauseLiftRefusal,
} from "@millionsend/core/deliverability";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { KV_SENTENCE, KvRow } from "@/components/kv-row";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { Tooltip } from "@/components/tooltip";
import { formatDayUtc } from "@/lib/format";
import { usePercent } from "../safety/parts";

export const PAUSE_REASONS = ["complaints", "report", "manual"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export const SUSPENSION_REASONS = ["phishing", "reputation", "non_payment", "manual"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/**
 * The reasons that offer to cancel and refund, each with its default:
 * phishing usually pays with a stolen card, the others are the operator's
 * call, and non-payment paid nothing.
 */
const REFUND_DEFAULT: Partial<Record<SuspensionReason, boolean>> = {
  phishing: true,
  reputation: false,
  manual: false,
};

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

/**
 * Every send refused until reinstated. A phishing suspension never emails the
 * owner. A team on a live Stripe subscription is offered its cancel and
 * refund, whose default follows the reason until the operator ticks or
 * unticks it.
 */
export function SuspendDialog({
  name,
  initialReason = "reputation",
  refundPlan,
  pending,
  onClose,
  onSubmit,
}: {
  name: string;
  initialReason?: SuspensionReason | undefined;
  /** The plan the team's live subscription bills; null without one, undefined while it loads. */
  refundPlan: string | null | undefined;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: HoldInput<SuspensionReason> & { refund: boolean }) => void;
}) {
  const t = useTranslations("console.teams.suspendDialog");
  const refundT = useTranslations("console.teams.refund");
  const common = useTranslations("console.common");
  const id = useId();
  const [reason, setReason] = useState<SuspensionReason>(initialReason);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [refundChoice, setRefundChoice] = useState<boolean | null>(null);
  const phishing = reason === "phishing";
  const refundDefault = REFUND_DEFAULT[reason];
  const refundOffer = refundPlan && refundDefault !== undefined ? refundPlan : null;
  const refund = refundOffer !== null && (refundChoice ?? refundDefault === true);
  // Submitting before the subscription is known would drop a refund the operator never saw.
  const busy = pending || refundPlan === undefined;

  function submit() {
    if (busy) return;
    const trimmed = note.trim();
    onSubmit({
      reason,
      ...(trimmed ? { note: trimmed } : {}),
      notify: notify && !phishing,
      refund,
    });
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
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {phishing ? null : (
            <NotifyRow
              id={`${id}-notify`}
              label={common("notifyOwner")}
              checked={notify}
              disabled={pending}
              onChange={setNotify}
            />
          )}
          {refundOffer ? (
            <NotifyRow
              id={`${id}-refund`}
              label={refundT("offer", { plan: refundOffer })}
              checked={refund}
              disabled={pending}
              onChange={setRefundChoice}
            />
          ) : null}
        </div>
        <ModalFooter>
          <CancelButton onClose={onClose} />
          <button type="submit" className="ms-btn ms-btn-destructive" disabled={busy}>
            <BtnSpinner on={busy} />
            {t("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** What a lift would take out, as the review page reads it. */
interface PauseLiftPreview {
  rate: number;
  sent: number;
  hardBounced: number;
  /** The pause window's first UTC day. */
  since: string;
  parked: number;
  lastLiftAt: Date | null;
}

/** A refusal's one sentence: the disabled lift button's tooltip and a refused confirm's toast. */
export function useLiftRefusal(): (
  refusal: PauseLiftRefusal,
  lift: { lastLiftAt: Date | null; nextLiftAt: Date | null },
) => string {
  const t = useTranslations("console.teams.liftRefusal");
  const locale = useLocale();
  const day = (at: Date | null) => (at ? formatDayUtc(at, locale) : "");
  return (refusal, lift) =>
    t(refusal, {
      window: PAUSE_WINDOW_DAYS,
      last: day(lift.lastLiftAt),
      next: day(lift.nextLiftAt),
    });
}

/**
 * Takes the pause window's sends and hard bounces out of the team's rates.
 * The reference and the note go on the record, so the confirm waits for both.
 */
export function LiftPauseDialog({
  name,
  lift,
  pending,
  onClose,
  onSubmit,
}: {
  name: string;
  lift: PauseLiftPreview;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { reference: string; note: string; notify: boolean }) => void;
}) {
  const t = useTranslations("console.teams.liftDialog");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const percent = usePercent();
  const id = useId();
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const valid = reference.trim() !== "" && note.trim() !== "";

  function submit() {
    if (pending || !valid) return;
    onSubmit({ reference: reference.trim(), note: note.trim(), notify });
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
          {t("lead", { window: PAUSE_WINDOW_DAYS, days: PAUSE_LIFT_COOLDOWN_DAYS })}
        </p>
        <dl className="ms-kv ms-kv-cols" style={{ marginBottom: 16 }}>
          <KvRow label={t("pausedOn")} valueStyle={KV_SENTENCE}>
            {t("pausedOnValue", { rate: percent(lift.rate), window: PAUSE_WINDOW_DAYS })}
          </KvRow>
          <KvRow label={t("leavesOut")} valueStyle={KV_SENTENCE}>
            {t("leavesOutValue", {
              bounces: lift.hardBounced,
              sent: lift.sent,
              since: formatDayUtc(lift.since, locale),
            })}
          </KvRow>
          <KvRow label={t("waiting")} valueStyle={KV_SENTENCE}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t("waitingValue", { count: lift.parked })}
              {lift.parked > 0 ? (
                <Tooltip text={t("waitingTip", { days: PAUSE_LIFT_COOLDOWN_DAYS })} />
              ) : null}
            </span>
          </KvRow>
          <KvRow label={t("lastLift")} valueStyle={KV_SENTENCE}>
            {lift.lastLiftAt ? formatDayUtc(lift.lastLiftAt, locale) : t("lastLiftNever")}
          </KvRow>
        </dl>
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
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-note`}>{t("note")}</label>
          <textarea
            id={`${id}-note`}
            className="ms-input"
            style={{ width: "100%", minHeight: 72, resize: "vertical" }}
            maxLength={1000}
            required
            disabled={pending}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
            {t("noteHint")}
          </p>
        </div>
        <NotifyRow
          id={`${id}-notify`}
          label={common("notifyOwner")}
          checked={notify}
          disabled={pending}
          onChange={setNotify}
        />
        <ModalFooter>
          <CancelButton onClose={onClose} />
          <button type="submit" className="ms-btn ms-btn-primary" disabled={pending || !valid}>
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
