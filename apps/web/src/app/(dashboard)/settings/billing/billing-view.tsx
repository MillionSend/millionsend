"use client";

import {
  formatVolume,
  PLAN_DOMAIN_LIMIT,
  PLAN_RUNGS,
  PLAN_TEAM_LIMIT,
  type Plan,
  type PlanRung,
  type PlanRungKey,
  planLabel,
} from "@millionsend/core/plans";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
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

function Check() {
  return (
    <span
      className="ms-mono"
      aria-hidden="true"
      style={{ fontSize: 11, color: "var(--ms-success)", flex: "none", lineHeight: "18px" }}
    >
      ✓
    </span>
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

  // The selector follows the team's own rung until the viewer picks another.
  const [picked, setPicked] = useState<PlanRungKey | null>(null);

  const fmt = new Intl.NumberFormat(locale);
  const usd = (cents: number) => formatUsd(cents, locale);
  const capLine = (rung: PlanRung) =>
    t(rung.period === "day" ? "capPerDay" : "capPerMonth", { n: fmt.format(rung.included) });

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
  const selected = PLAN_RUNGS.find((r) => r.key === picked) ?? current;
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
    return [
      domains === null ? t("features.domainsUnlimited") : t("features.domains", { n: domains }),
      t(p === "free" ? "features.contactsFairUse" : "features.contacts"),
      t("features.broadcasts"),
      t("features.integrations"),
      t("features.teams", { n: PLAN_TEAM_LIMIT[p] }),
      t("features.history"),
      t(`features.support.${p}`),
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

      <Card title={t("plansTitle")}>
        <div
          className="ms-wrap-row"
          style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}
        >
          <span className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("volume")}
          </span>
          <div
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              gap: 2,
              padding: 2,
              background: "var(--ms-inset)",
              border: "1px solid var(--ms-line)",
              borderRadius: "var(--ms-r-pill)",
            }}
          >
            {PLAN_RUNGS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={r.key === selected.key ? "ms-code-tab active" : "ms-code-tab"}
                aria-pressed={r.key === selected.key}
                style={{ borderRadius: "var(--ms-r-pill)" }}
                onClick={() => setPicked(r.key)}
              >
                <span className="ms-digits">
                  {formatVolume(r.period === "day" ? r.included * 30 : r.included)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
          }}
        >
          {PLANS.map((p) => {
            // A plan shows the rung the selector landed on when it is one of
            // its own, else its entry rung.
            const r =
              selected.plan === p ? selected : (PLAN_RUNGS.find((x) => x.plan === p) ?? selected);
            const lit = r.key === selected.key;
            const isCurrent = r.key === current.key;
            const forSale = canManage && r.priceCents > 0 && !isCurrent;
            return (
              <div
                key={p}
                style={{
                  padding: "16px 18px",
                  borderRadius: 12,
                  border: `1px solid ${lit ? "var(--ms-steel)" : "var(--ms-line)"}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="ms-display" style={{ fontSize: 16, color: "var(--ms-bone)" }}>
                    {planName(p)}
                  </span>
                  {isCurrent ? (
                    <span className="ms-badge ms-badge-neutral">{t("current")}</span>
                  ) : null}
                </div>
                <div
                  className="ms-digits"
                  style={{ fontSize: 26, color: "var(--ms-bone)", lineHeight: 1 }}
                >
                  <Odometer formatted={usd(r.priceCents)} />
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ms-muted)" }}>
                    {" "}
                    {t("perMonth")}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--ms-bone)" }}>{capLine(r)}</div>
                <div style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
                  {r.overageCentsPer1k === null
                    ? t("noOverage")
                    : t("overagePer1k", { price: usd(r.overageCentsPer1k) })}
                </div>
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "grid",
                    gap: 6,
                    fontSize: 12.5,
                    lineHeight: "18px",
                    color: "var(--ms-muted)",
                    flex: 1,
                  }}
                >
                  {features(p).map((f) => (
                    <li key={f} style={{ display: "flex", gap: 8 }}>
                      <Check />
                      {f}
                    </li>
                  ))}
                </ul>
                {forSale ? (
                  <button
                    type="button"
                    className={`ms-btn ${lit ? "ms-btn-primary" : "ms-btn-secondary"}`}
                    disabled={busy}
                    onClick={() =>
                      hasLiveSubscription
                        ? changePlan.mutate({ rung: r.key })
                        : startCheckout.mutate({ rung: r.key })
                    }
                  >
                    <BtnSpinner
                      on={
                        (startCheckout.isPending && startCheckout.variables?.rung === r.key) ||
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
            );
          })}
        </div>
        {canManage && hasLiveSubscription ? (
          <p style={{ margin: "14px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
            {t("changeHint")}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
