"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { PLAN_DAY_LIMIT, planLabel, RUNG_PRICE_CENTS } from "@/lib/console-format";
import { formatUsd } from "@/lib/format";
import { usePlanName } from "./cells";
import type { Rung, TeamDetail } from "./types";

function PlanForm({
  detail,
  pending,
  onClose,
  onSubmit,
}: {
  detail: TeamDetail;
  pending: boolean;
  onClose: () => void;
  onSubmit: (rung: Rung, label: string) => void;
}) {
  const t = useTranslations("console.teams");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const planName = usePlanName();
  const id = useId();
  const current = detail.rungs.find(
    (r) => r.plan === detail.plan && r.planQuota === detail.planQuota,
  );
  const [key, setKey] = useState(current?.key ?? "");
  const managed = detail.stripeSubscriptionId !== null;

  const label = (rung: Rung) => planLabel(planName(rung.plan), rung.planQuota);
  const sub = (rung: Rung): string => {
    if (rung.key === "system") return t("planDialog.rungs.system");
    const day = PLAN_DAY_LIMIT[rung.key];
    const price = RUNG_PRICE_CENTS[rung.key];
    if (day !== undefined && price === undefined) {
      return t("planDialog.rungs.free", { limit: nf.format(day) });
    }
    if (day !== undefined && price !== undefined) {
      return t("planDialog.rungs.starter", {
        limit: nf.format(day),
        price: formatUsd(price, locale),
      });
    }
    return t("planDialog.rungs.month", { price: formatUsd(price ?? 0, locale) });
  };

  const picked = detail.rungs.find((r) => r.key === key);
  const canConfirm = !pending && !managed && picked !== undefined && picked.key !== current?.key;
  function submit() {
    if (!canConfirm || !picked) return;
    onSubmit(picked, label(picked));
  }

  return (
    <Modal
      open
      onClose={onClose}
      onConfirm={submit}
      title={t("planDialog.title", { team: detail.name })}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="ms-field" style={{ marginTop: 6 }}>
          <label htmlFor={`${id}-${detail.rungs[0]?.key}`}>{t("planDialog.rung")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {detail.rungs.map((rung) => (
              <label key={rung.key} className="ms-radio-card">
                <input
                  id={`${id}-${rung.key}`}
                  type="radio"
                  name={`${id}-rung`}
                  checked={key === rung.key}
                  disabled={pending || managed}
                  onChange={() => setKey(rung.key)}
                />
                <span>
                  {label(rung)}
                  <div className="sub">{sub(rung)}</div>
                </span>
              </label>
            ))}
          </div>
        </div>
        <p
          style={{ margin: "14px 0 0", color: "var(--ms-muted)", fontSize: 12.5, lineHeight: 1.5 }}
        >
          {t("planDialog.note")}
        </p>
        {managed ? (
          <p
            style={{ margin: "10px 0 0", color: "var(--ms-warn)", fontSize: 12.5, lineHeight: 1.5 }}
          >
            {t("planDialog.managed")}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={!canConfirm}>
            <BtnSpinner on={pending} />
            {t("planDialog.confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** The rung ladder as radio cards; a Stripe-managed team sees it read-only. */
export function PlanDialog({
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
  onSubmit: (rung: Rung, label: string) => void;
}) {
  const t = useTranslations("console.teams");
  if (detail) {
    return <PlanForm detail={detail} pending={pending} onClose={onClose} onSubmit={onSubmit} />;
  }
  return (
    <Modal open onClose={onClose} title={t("planDialog.title", { team: name })}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} width="100%" height={46} radius="var(--ms-r-input)" />
        ))}
      </div>
    </Modal>
  );
}
