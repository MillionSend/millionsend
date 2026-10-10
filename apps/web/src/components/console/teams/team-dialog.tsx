"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { KvRow } from "@/components/kv-row";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { Skeleton } from "@/components/skeleton";
import { Tooltip } from "@/components/tooltip";
import { planLabel } from "@/lib/console-format";
import { formatDayTime, formatMmSs, formatRelative } from "@/lib/format";
import { formatScoreTenths } from "@/lib/score-band";
import { useCountdown } from "@/lib/use-countdown";
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

function LiveViewLine({ expiresAt }: { expiresAt: Date }) {
  const t = useTranslations("console.teams");
  const left = formatMmSs(useCountdown(expiresAt));
  return (
    <p style={{ margin: "0 0 16px", color: "var(--ms-warn)", fontSize: 13 }}>
      {t("detail.supportView", { left })}
    </p>
  );
}

/** Everything the console knows about one team, with Adjust limits as the way out. */
export function TeamDialog({
  name,
  detail,
  onClose,
  onAdjustLimits,
  onViewAsOwner,
}: {
  name: string;
  detail: TeamDetail | undefined;
  onClose: () => void;
  onAdjustLimits: () => void;
  onViewAsOwner: () => void;
}) {
  const t = useTranslations("console.teams");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const planName = usePlanName();
  const none = common("none");

  const owner = detail?.members.find((m) => m.role === "owner") ?? detail?.members[0];
  const viewOff = !detail?.supportViewEnabled
    ? "viewOff"
    : detail.silentlySuspended
      ? "viewSilent"
      : null;
  const memberEmails = detail?.members.map((m) => m.email).join(", ") ?? "";

  return (
    <Modal open onClose={onClose} onConfirm={onAdjustLimits} title={name} size="wide">
      <p style={{ margin: "6px 0 18px", color: "var(--ms-muted)", fontSize: 13.5 }}>
        {t("detail.lead")}
      </p>
      {detail?.supportView ? <LiveViewLine expiresAt={detail.supportView.expiresAt} /> : null}
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
              value={t("detail.domainsValue", { count: detail.domains })}
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
            <KvRow label={t("detail.type")}>
              {planLabel(planName(detail.plan), detail.planQuota)}
            </KvRow>
            <KvRow label={t("detail.owner")}>{owner?.email ?? none}</KvRow>
            <KvRow label={t("detail.members")}>
              {memberEmails ? (
                <Tooltip inline text={memberEmails}>
                  {nf.format(detail.members.length)}
                </Tooltip>
              ) : (
                nf.format(0)
              )}
            </KvRow>
            <KvRow label={t("detail.region")}>
              <RegionLabel region={detail.region} />
            </KvRow>
            <KvRow label={t("detail.guardrail")}>
              <GuardrailLabel
                guardrail={detail.guardrail}
                suspendedAt={detail.suspendedAt}
                broadcastsPausedByOperatorAt={detail.broadcastsPausedByOperatorAt}
              />
            </KvRow>
            <KvRow label={t("detail.created")}>{formatDayTime(detail.createdAt, locale)}</KvRow>
            <KvRow label={t("detail.stripe")}>
              {detail.stripeSubscriptionId
                ? t.rich("detail.stripeSub", {
                    id: detail.stripeSubscriptionId,
                    status: detail.planStatus ?? none,
                    link: (chunks) =>
                      detail.stripeSubscriptionUrl ? (
                        <a
                          className="ms-link"
                          href={detail.stripeSubscriptionUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {chunks} ↗
                        </a>
                      ) : (
                        chunks
                      ),
                  })
                : t("detail.stripeNone")}
            </KvRow>
            <KvRow label={t("detail.ceiling")}>
              {detail.dailySendCeiling === null
                ? t("detail.ceilingNone")
                : nf.format(detail.dailySendCeiling)}
            </KvRow>
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
              <KvRow key={key} label={t(`detail.${key}`)}>
                <Skeleton width={120} />
              </KvRow>
            ),
          )}
        </dl>
      )}
      <ModalFooter>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
          {common("close")} <span className="ms-keycap">Esc</span>
        </button>
        {detail && viewOff ? (
          // Inline, so the trigger is a span: the default trigger is itself a
          // button, and a button inside a button is invalid nesting the
          // browser may reparent. The span is focusable, so the reason
          // reaches a keyboard user too.
          <Tooltip inline text={t(`menu.${viewOff}`)}>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled
              style={{ pointerEvents: "none" }}
            >
              {t("menu.view")}
            </button>
          </Tooltip>
        ) : (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={!detail}
            onClick={onViewAsOwner}
          >
            {t("menu.view")}
          </button>
        )}
        <button type="button" className="ms-btn ms-btn-primary" onClick={onAdjustLimits}>
          {t("menu.limits")}
        </button>
      </ModalFooter>
    </Modal>
  );
}
