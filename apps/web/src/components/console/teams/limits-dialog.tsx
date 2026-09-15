"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { PLAN_DAY_LIMIT } from "@/lib/console-format";
import type { TeamDetail } from "./types";

export interface LimitsInput {
  dailySendCeiling: number | null;
  broadcastsPaused: boolean;
}

/** What the plan would allow, so an empty ceiling field says what "plan decides" means. */
function ceilingPlaceholder(
  detail: TeamDetail,
  t: ReturnType<typeof useTranslations>,
  nf: Intl.NumberFormat,
): string {
  const day = PLAN_DAY_LIMIT[detail.plan];
  if (day !== undefined) return t("limitsDialog.ceilingPlaceholderDay", { limit: nf.format(day) });
  if (detail.planQuota) {
    return t("limitsDialog.ceilingPlaceholderMonth", { included: nf.format(detail.planQuota) });
  }
  if (detail.plan === "system") return t("limitsDialog.ceilingPlaceholderNone");
  return t("limitsDialog.ceilingPlaceholder");
}

function LimitsForm({
  detail,
  pending,
  onClose,
  onSubmit,
}: {
  detail: TeamDetail;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: LimitsInput) => void;
}) {
  const t = useTranslations("console.teams");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const id = useId();
  const [ceiling, setCeiling] = useState(
    detail.dailySendCeiling === null ? "" : String(detail.dailySendCeiling),
  );
  const [paused, setPaused] = useState(detail.broadcastsPausedByOperatorAt !== null);

  const parsed = ceiling.trim() === "" ? null : Number(ceiling);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1);
  function submit() {
    if (pending || !valid) return;
    onSubmit({ dailySendCeiling: parsed, broadcastsPaused: paused });
  }

  return (
    <Modal
      open
      onClose={onClose}
      onConfirm={submit}
      title={t("limitsDialog.title", { team: detail.name })}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p style={{ margin: "6px 0 16px", color: "var(--ms-muted)", fontSize: 13.5 }}>
          {t("limitsDialog.lead")}
        </p>
        <div className="ms-field" style={{ marginBottom: 16 }}>
          <label htmlFor={`${id}-ceiling`}>{t("limitsDialog.ceiling")}</label>
          <input
            id={`${id}-ceiling`}
            type="number"
            min={1}
            step={1}
            className={valid ? "ms-input" : "ms-input error"}
            style={{ width: "100%" }}
            placeholder={ceilingPlaceholder(detail, t, nf)}
            value={ceiling}
            disabled={pending}
            onChange={(event) => setCeiling(event.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor={`${id}-allowed`}>{t("limitsDialog.broadcasts")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className="ms-radio-card">
              <input
                id={`${id}-allowed`}
                type="radio"
                name={`${id}-broadcasts`}
                checked={!paused}
                disabled={pending}
                onChange={() => setPaused(false)}
              />
              <span>
                {t("limitsDialog.allowed")}
                <div className="sub">{t("limitsDialog.allowedSub")}</div>
              </span>
            </label>
            <label className="ms-radio-card">
              <input
                type="radio"
                name={`${id}-broadcasts`}
                checked={paused}
                disabled={pending}
                onChange={() => setPaused(true)}
              />
              <span>
                {t("limitsDialog.paused")}
                <div className="sub">{t("limitsDialog.pausedSub")}</div>
              </span>
            </label>
          </div>
        </div>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={pending || !valid}>
            <BtnSpinner on={pending} />
            {common("save")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Daily ceiling + broadcast switch; the form mounts once the team's current values are known. */
export function LimitsDialog({
  name,
  detail,
  pending,
  onClose,
  onSubmit,
}: {
  name: string;
  detail: TeamDetail | undefined;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: LimitsInput) => void;
}) {
  const t = useTranslations("console.teams");
  if (detail) {
    return <LimitsForm detail={detail} pending={pending} onClose={onClose} onSubmit={onSubmit} />;
  }
  return (
    <Modal open onClose={onClose} title={t("limitsDialog.title", { team: name })}>
      <p style={{ margin: "6px 0 16px", color: "var(--ms-muted)", fontSize: 13.5 }}>
        {t("limitsDialog.lead")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton width="100%" height={30} radius="var(--ms-r-input)" />
        <Skeleton width="100%" height={46} radius="var(--ms-r-input)" />
        <Skeleton width="100%" height={46} radius="var(--ms-r-input)" />
      </div>
    </Modal>
  );
}
