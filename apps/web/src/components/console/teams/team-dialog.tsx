"use client";

import { useLocale, useTranslations } from "next-intl";
import { Fragment, useMemo } from "react";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { Skeleton } from "@/components/skeleton";
import { Tooltip } from "@/components/tooltip";
import { planLabel } from "@/lib/console-format";
import { formatDayTime, formatRelative } from "@/lib/format";
import { formatScoreTenths } from "@/lib/score-band";
import { GuardrailLabel, RegionLabel, usePlanName } from "./cells";
import type { TeamDetail } from "./types";

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="ms-microlabel">{label}</div>
      <div className="ms-digits" style={{ fontSize: 24 }}>
        {value}
      </div>
    </div>
  );
}

/** Everything the console knows about one team, with Adjust limits as the way out. */
export function TeamDialog({
  name,
  detail,
  onClose,
  onAdjustLimits,
}: {
  name: string;
  detail: TeamDetail | undefined;
  onClose: () => void;
  onAdjustLimits: () => void;
}) {
  const t = useTranslations("console.teams");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const planName = usePlanName();
  const none = common("none");

  const owner = detail?.members.find((m) => m.role === "owner") ?? detail?.members[0];
  const memberEmails = detail?.members.map((m) => m.email).join(", ") ?? "";

  return (
    <Modal open onClose={onClose} onConfirm={onAdjustLimits} title={name} size="wide">
      <p style={{ margin: "6px 0 18px", color: "var(--ms-muted)", fontSize: 13.5 }}>
        {t("detail.lead")}
      </p>
      <div className="ms-grid ms-grid-2" style={{ gap: 12, marginBottom: 16 }}>
        {detail ? (
          <>
            <Figure
              label={t("detail.sent30d")}
              value={detail.sent30d === null ? none : nf.format(detail.sent30d)}
            />
            <Figure label={t("detail.contacts")} value={nf.format(detail.contacts)} />
            <Figure
              label={t("detail.score")}
              value={
                detail.scoreTenths === null
                  ? none
                  : t("detail.scoreOf", { score: formatScoreTenths(detail.scoreTenths, locale) })
              }
            />
            <Figure
              label={t("detail.domains")}
              value={t("detail.domainsValue", { count: nf.format(detail.domains) })}
            />
          </>
        ) : (
          ["sent30d", "contacts", "score", "domains"].map((key) => (
            <Figure
              key={key}
              label={t(`detail.${key}`)}
              value={<Skeleton width={80} height={24} />}
            />
          ))
        )}
      </div>
      {detail ? (
        <>
          <dl className="ms-kv">
            <dt>{t("detail.type")}</dt>
            <dd>{planLabel(planName(detail.plan), detail.planQuota)}</dd>
            <dt>{t("detail.owner")}</dt>
            <dd>{owner?.email ?? none}</dd>
            <dt>{t("detail.members")}</dt>
            <dd>
              {memberEmails ? (
                <Tooltip inline text={memberEmails}>
                  {nf.format(detail.members.length)}
                </Tooltip>
              ) : (
                nf.format(0)
              )}
            </dd>
            <dt>{t("detail.region")}</dt>
            <dd>
              <RegionLabel region={detail.region} />
            </dd>
            <dt>{t("detail.guardrail")}</dt>
            <dd>
              <GuardrailLabel
                guardrail={detail.guardrail}
                suspendedAt={detail.suspendedAt}
                broadcastsPausedByOperatorAt={detail.broadcastsPausedByOperatorAt}
              />
            </dd>
            <dt>{t("detail.created")}</dt>
            <dd>{formatDayTime(detail.createdAt, locale)}</dd>
            <dt>{t("detail.stripe")}</dt>
            <dd>
              {detail.stripeSubscriptionId
                ? t("detail.stripeSub", {
                    id: detail.stripeSubscriptionId,
                    status: detail.planStatus ?? none,
                  })
                : t("detail.stripeNone")}
            </dd>
            <dt>{t("detail.ceiling")}</dt>
            <dd>
              {detail.dailySendCeiling === null
                ? t("detail.ceilingNone")
                : nf.format(detail.dailySendCeiling)}
            </dd>
          </dl>
          {detail.standingAt ? (
            <p style={{ margin: "12px 0 0", color: "var(--ms-muted)", fontSize: 12 }}>
              {t("detail.standingAt", { ago: formatRelative(detail.standingAt, locale) })}
            </p>
          ) : null}
        </>
      ) : (
        <dl className="ms-kv">
          {["type", "owner", "members", "region", "guardrail", "created", "stripe", "ceiling"].map(
            (key) => (
              <Fragment key={key}>
                <dt>{t(`detail.${key}`)}</dt>
                <dd>
                  <Skeleton width={120} />
                </dd>
              </Fragment>
            ),
          )}
        </dl>
      )}
      <ModalFooter>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
          {common("close")} <span className="ms-keycap">Esc</span>
        </button>
        <button type="button" className="ms-btn ms-btn-primary" onClick={onAdjustLimits}>
          {t("menu.limits")}
        </button>
      </ModalFooter>
    </Modal>
  );
}
