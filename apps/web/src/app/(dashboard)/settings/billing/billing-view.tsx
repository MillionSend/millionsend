"use client";

import {
  formatVolume,
  PLAN_CONTACT_LIMIT,
  PLAN_DOMAIN_LIMIT,
  PLAN_RUNGS,
  type Plan,
  type PlanRung,
  planLabel,
} from "@millionsend/core/plans";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type CSSProperties, type ReactNode, useState } from "react";
import { Modal } from "@/components/modal";
import { Odometer } from "@/components/odometer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Switch } from "@/components/switch";
import { WarnCard } from "@/components/warn-card";
import { formatDay, formatDayTime, formatUsd } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { QuotaRow } from "../usage/usage-view";

const PLANS = ["free", "starter", "pro", "scale"] as const satisfies readonly Plan[];
/* The slider's stops are the rungs themselves; a daily cap sits on the monthly axis as thirty days of it. */
const LAST_STEP = PLAN_RUNGS.length - 1;
const stepVolume = (r: PlanRung) => (r.period === "day" ? r.included * 30 : r.included);

/** Subscription status → badge tone: paying reads healthy, grace warns, lapsed is a danger. */
const STATUS_TONE = {
  none: "neutral",
  active: "success",
  trialing: "success",
  past_due: "warn",
  unpaid: "danger",
  canceled: "danger",
  incomplete: "danger",
} as const;

// The webhook flips the plan after Stripe confirms payment, a few seconds
// after the redirect lands; a short burst of refetches picks it up.
const POST_CHECKOUT_POLLS = 6;
const POST_CHECKOUT_POLL_MS = 2500;

function Card({
  title,
  action,
  children,
}: {
  title: string;
  /** Right-aligned control on the title row (the card's primary action). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          margin: "0 0 18px",
        }}
      >
        <h2
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: 0 }}
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function BillingSkeleton({ title }: { title: string }) {
  return (
    <Card title={title}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Skeleton width={120} height={28} />
        <Skeleton width={64} height={20} radius={999} />
      </div>
      <div style={{ display: "flex", gap: 48, marginTop: 22 }}>
        <Skeleton width={90} height={40} />
        <Skeleton width={140} height={40} />
      </div>
    </Card>
  );
}

/** The green check in front of every feature line (color comes from .ms-checklist-mark). */
function Check() {
  return (
    <svg
      className="ms-checklist-mark"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

export function BillingView({ checkout }: { checkout: "success" | "cancel" | null }) {
  const t = useTranslations("settings.billing");
  const planName = useTranslations("settings.plans");
  const usageT = useTranslations("settings.usage");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const status = useQuery({
    ...trpc.billing.status.queryOptions(),
    refetchInterval: (query) =>
      checkout === "success" && query.state.dataUpdateCount < POST_CHECKOUT_POLLS
        ? POST_CHECKOUT_POLL_MS
        : false,
  });
  const teams = useQuery(trpc.team.list.queryOptions());
  const role = teams.data?.teams.find((m) => m.teamId === teams.data.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";

  const redirect = { onSuccess: ({ url }: { url: string }) => window.location.assign(url) };
  // The sidebar meter and the cap banner read usage.recent; team.list carries the plan.
  const refresh = {
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.billing.status.queryFilter()),
        queryClient.invalidateQueries(trpc.settings.usage.recent.queryFilter()),
        queryClient.invalidateQueries(trpc.team.list.queryFilter()),
      ]),
  };
  const startCheckout = useMutation(trpc.billing.checkout.mutationOptions(redirect));
  const openPortal = useMutation(trpc.billing.portal.mutationOptions(redirect));
  const changePlan = useMutation(trpc.billing.changePlan.mutationOptions(refresh));
  const setOverage = useMutation(trpc.billing.setOverage.mutationOptions(refresh));
  const mutations = [startCheckout, openPortal, changePlan, setOverage];
  const busy = mutations.some((m) => m.isPending);
  const failed = mutations.some((m) => m.isError);

  // The slider follows the team's own rung until the viewer moves it.
  const [step, setStep] = useState<number | null>(null);
  const [plansOpen, setPlansOpen] = useState(false);

  const fmt = new Intl.NumberFormat(locale);
  const usd = (cents: number) => formatUsd(cents, locale);

  const notice =
    checkout === "success" ? (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 16px",
          borderRadius: 12,
          border: "1px solid var(--ms-success-border)",
          backgroundColor: "var(--ms-ground)",
          backgroundImage: statusGlow("success", 15),
          fontSize: "var(--ms-fs-ui)",
        }}
      >
        <span
          className="ms-mono"
          aria-hidden="true"
          style={{ fontSize: 11, color: "var(--ms-success)" }}
        >
          ✓
        </span>
        {t("checkoutSuccess")}
      </div>
    ) : checkout === "cancel" ? (
      <div role="status" className="ms-toast ms-toast-neutral">
        <span className="ms-toast-icon" aria-hidden="true">
          i
        </span>
        {t("checkoutCancel")}
      </div>
    ) : null;

  if (!status.data) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
        {notice}
        <BillingSkeleton title={t("plan")} />
      </div>
    );
  }

  const {
    plan,
    planQuota,
    rung: currentKey,
    pendingRung,
    planStatus,
    currentPeriodEnd,
    quota,
    usage,
    hasCustomer,
    hasLiveSubscription,
  } = status.data;
  const current = PLAN_RUNGS.find((r) => r.key === currentKey) ?? PLAN_RUNGS[0];
  const pending = PLAN_RUNGS.find((r) => r.key === pendingRung) ?? null;
  const at =
    step ??
    Math.max(
      0,
      PLAN_RUNGS.findIndex((r) => r.key === current.key),
    );
  const selected = PLAN_RUNGS[at] ?? current;
  const over = quota.kind === "month" ? Math.max(0, usage.accepted - quota.included) : 0;

  const portalButton = (label: string, className: string) => (
    <button
      type="button"
      className={`ms-btn ${className}`}
      disabled={busy}
      onClick={() => openPortal.mutate()}
    >
      <BtnSpinner on={openPortal.isPending} />
      {label}
    </button>
  );

  const features = (p: Plan): string[] => {
    const domains = PLAN_DOMAIN_LIMIT[p];
    const contacts = PLAN_CONTACT_LIMIT[p];
    return [
      domains === null ? t("features.domainsUnlimited") : t("features.domains", { n: domains }),
      contacts === null ? t("features.contacts") : t("features.contactsLimit", { n: contacts }),
      t("features.broadcasts"),
      t("features.integrations"),
      t("features.agents"),
    ];
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
      {notice}

      <Card
        title={t("plan")}
        action={canManage && hasCustomer ? portalButton(t("manage"), "ms-btn-secondary") : null}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", lineHeight: 1 }}
          >
            {planLabel(plan, planQuota)}
          </span>
          {/* Optical: the display face sits a hair low in its line box, so the
              pill follows its cap height rather than the box center. */}
          <span
            className={`ms-badge ms-badge-${STATUS_TONE[planStatus]}`}
            style={{ position: "relative", top: 1 }}
          >
            {t(`status.${planStatus}`)}
          </span>
        </div>

        <div className="ms-kpi-row" style={{ display: "flex", gap: 48, marginTop: 22 }}>
          <div>
            <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
              {t("cap")}
            </div>
            <div style={{ marginTop: 6, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
              {quota.kind === "day"
                ? t("capPerDay", { n: fmt.format(quota.limit) })
                : quota.kind === "month"
                  ? t("capPerMonth", { n: fmt.format(quota.included) })
                  : null}
            </div>
          </div>
          {currentPeriodEnd && plan !== "free" ? (
            <div>
              <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
                {t("renewsOn")}
              </div>
              <div style={{ marginTop: 6, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
                {formatDayTime(currentPeriodEnd, locale)}
              </div>
            </div>
          ) : null}
        </div>

        {pending && currentPeriodEnd ? (
          <div
            className="ms-wrap-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
              fontSize: 13,
              color: "var(--ms-muted)",
            }}
          >
            <span>
              {t("pendingChange", {
                plan: planLabel(pending.plan, pending.period === "month" ? pending.included : null),
                date: formatDay(currentPeriodEnd, locale),
              })}
            </span>
            {canManage ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={busy}
                onClick={() => changePlan.mutate({ rung: current.key })}
              >
                <BtnSpinner
                  on={changePlan.isPending && changePlan.variables?.rung === current.key}
                />
                {t("keepPlan", { plan: planLabel(plan, planQuota) })}
              </button>
            ) : null}
          </div>
        ) : null}

        {planStatus === "past_due" ? (
          <WarnCard action={canManage ? portalButton(t("updateCard"), "ms-btn-secondary") : null}>
            {t("pastDue")}
          </WarnCard>
        ) : null}

        <p
          style={{
            margin: "14px 0 0",
            fontSize: 13,
            color: failed ? "var(--ms-danger)" : "var(--ms-muted)",
          }}
        >
          {failed ? t("error") : canManage ? t("manageHint") : t("readOnly")}
        </p>
      </Card>

      <Card title={t("usageTitle")}>
        {quota.kind === "month" ? (
          <>
            <QuotaRow
              label={usageT("sentThisPeriod")}
              hint={usageT("renewsOn", { date: formatDay(quota.periodEnd, locale) })}
              used={usage.accepted}
              limit={quota.included}
            />
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
                marginTop: 18,
                paddingTop: 18,
                borderTop: "1px solid var(--ms-line)",
              }}
            >
              <Switch
                checked={quota.overage}
                disabled={!canManage || !hasLiveSubscription || busy}
                onChange={(enabled) => setOverage.mutate({ enabled })}
                ariaLabel={t("overage")}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>{t("overage")}</div>
                <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 2 }}>
                  {t("overageCopy", { price: usd(quota.overageCentsPer1k) })}
                </div>
                {over > 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--ms-bone)", marginTop: 6 }}>
                    {t("overSoFar", {
                      n: over,
                      amount: usd(Math.round((over * quota.overageCentsPer1k) / 1000)),
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <QuotaRow
            label={usageT("sentToday")}
            hint={usageT("resetsMidnightUtc")}
            used={usage.accepted}
            limit={quota.kind === "day" ? quota.limit : null}
          />
        )}
      </Card>

      <Card
        title={t("plansTitle")}
        action={
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => setPlansOpen(true)}
          >
            {t("comparePlans")}
          </button>
        }
      >
        <div className="ms-plan-strip">
          {PLANS.map((p) => {
            const rungs = PLAN_RUNGS.filter((x) => x.plan === p);
            const price = usd(rungs[0]?.priceCents ?? 0);
            return (
              <div
                key={p}
                className="ms-plan-strip-item"
                data-current={p === current.plan || undefined}
              >
                <span className="ms-plan-strip-name">{planName(p)}</span>
                <span className="ms-plan-strip-price">
                  {rungs.length > 1 ? t("fromPrice", { price }) : price} {t("perMonth")}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
      {/* The ladder needs more width than the content column beside the
          sidebar gives it, so it opens in a dialog that fills the viewport. */}
      <Modal
        open={plansOpen}
        onClose={() => setPlansOpen(false)}
        title={t("plansTitle")}
        size="full"
      >
        <div className="ms-plan-dialog">
          <div className="ms-volume">
            <label htmlFor="ms-volume" className="ms-microlabel">
              {t("volume")}
            </label>
            <input
              id="ms-volume"
              className="ms-slider"
              type="range"
              min={0}
              max={LAST_STEP}
              step={1}
              value={at}
              onChange={(e) => setStep(Number(e.target.value))}
              aria-valuetext={`${fmt.format(stepVolume(selected))} ${t("emailsAMonth")}`}
              style={{ "--ms-slider-p": `${(at / LAST_STEP) * 100}%` } as CSSProperties}
            />
            <div className="ms-slider-marks">
              {PLAN_RUNGS.map((r, i) => (
                <button
                  key={r.key}
                  type="button"
                  tabIndex={-1}
                  className="ms-digits"
                  data-on={i === at || undefined}
                  onClick={() => setStep(i)}
                >
                  {formatVolume(stepVolume(r))}
                </button>
              ))}
            </div>
            <p className="ms-slider-hint">{t("sliderHint")}</p>
          </div>
          <div className="ms-plans">
            {PLANS.map((p) => {
              const active = selected.plan === p;
              // A plan shows the rung the slider landed on when it is one of
              // its own, else its entry rung.
              const r = active ? selected : (PLAN_RUNGS.find((x) => x.plan === p) ?? selected);
              const isCurrent = r.key === current.key;
              const forSale = canManage && r.priceCents > 0 && !isCurrent;
              return (
                <div key={p} className="ms-plan" data-open={active || undefined}>
                  <div className="ms-plan-name">{planName(p)}</div>
                  <div className="ms-plan-price">
                    <span className="ms-digits">
                      <Odometer formatted={usd(r.priceCents)} lit={false} />
                    </span>
                    <span className="ms-plan-per">{t("perMonth")}</span>
                  </div>
                  <div className="ms-plan-cap">
                    <span className="ms-digits">{fmt.format(r.included)}</span>
                    <span className="ms-plan-per">
                      {t(r.period === "day" ? "emailsADay" : "emailsAMonth")}
                    </span>
                  </div>
                  {/* Daily plans have no overage line; a blank one keeps the four cards' rows aligned. */}
                  <span
                    className="ms-plan-over"
                    data-empty={r.overageCentsPer1k === null || undefined}
                  >
                    {r.overageCentsPer1k === null
                      ? "\u00a0"
                      : t("overagePer1k", { price: usd(r.overageCentsPer1k) })}
                  </span>
                  <div className="ms-plan-more">
                    <div>
                      <ul className="ms-checklist">
                        {features(p).map((f) => (
                          <li key={f}>
                            <Check />
                            {f}
                          </li>
                        ))}
                      </ul>
                      {isCurrent ? (
                        <button type="button" className="ms-btn ms-btn-secondary" disabled>
                          {t("current")}
                        </button>
                      ) : forSale ? (
                        <button
                          type="button"
                          className={`ms-btn ${active ? "ms-btn-primary" : "ms-btn-secondary"}`}
                          disabled={busy}
                          onClick={() =>
                            hasLiveSubscription
                              ? changePlan.mutate({ rung: r.key })
                              : startCheckout.mutate({ rung: r.key })
                          }
                        >
                          <BtnSpinner
                            on={
                              (startCheckout.isPending &&
                                startCheckout.variables?.rung === r.key) ||
                              (changePlan.isPending && changePlan.variables?.rung === r.key)
                            }
                          />
                          {hasLiveSubscription
                            ? r.priceCents < current.priceCents
                              ? t("switchAtPeriodEnd")
                              : t("switch")
                            : t("choose")}
                        </button>
                      ) : p === "free" && canManage && hasLiveSubscription ? (
                        <p style={{ margin: 0, fontSize: 12, color: "var(--ms-muted)" }}>
                          {t("freeHint")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {canManage && hasLiveSubscription ? (
            <p
              style={{
                margin: "14px 0 0",
                fontSize: 12.5,
                color: "var(--ms-muted)",
                textAlign: "center",
              }}
            >
              {t("changeHint")}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
