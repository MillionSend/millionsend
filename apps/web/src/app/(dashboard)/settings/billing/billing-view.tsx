"use client";

import { PLAN_DAILY_LIMIT, type Plan } from "@millionsend/core/plans";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { WarnCard } from "@/components/warn-card";
import { formatDayTime } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { QuotaRow } from "../usage/usage-view";

const PLANS = ["free", "pro", "scale"] as const satisfies readonly Plan[];

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

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <h2
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 18px" }}
      >
        {title}
      </h2>
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

export function BillingView({ checkout }: { checkout: "success" | "cancel" | null }) {
  const t = useTranslations("settings.billing");
  const planName = useTranslations("settings.plans");
  const usageT = useTranslations("settings.usage");
  const locale = useLocale();
  const trpc = useTRPC();

  const status = useQuery({
    ...trpc.billing.status.queryOptions(),
    refetchInterval: (query) =>
      checkout === "success" && query.state.dataUpdateCount < POST_CHECKOUT_POLLS
        ? POST_CHECKOUT_POLL_MS
        : false,
  });
  const usage = useQuery(trpc.settings.usage.recent.queryOptions({}));
  const teams = useQuery(trpc.team.list.queryOptions());
  const role = teams.data?.teams.find((m) => m.teamId === teams.data.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";

  const redirect = { onSuccess: ({ url }: { url: string }) => window.location.assign(url) };
  const startCheckout = useMutation(trpc.billing.checkout.mutationOptions(redirect));
  const openPortal = useMutation(trpc.billing.portal.mutationOptions(redirect));
  const busy = startCheckout.isPending || openPortal.isPending;
  const failed = startCheckout.isError || openPortal.isError;

  const fmt = new Intl.NumberFormat(locale);
  const limitLabel = (limit: number | null) =>
    limit === null ? t("unlimited") : t("perDay", { limit: fmt.format(limit) });

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
      <div style={{ display: "grid", gap: 20 }}>
        {notice}
        <BillingSkeleton title={t("plan")} />
      </div>
    );
  }

  const { plan, planStatus, currentPeriodEnd, dailyLimit, hasCustomer, canCheckout } = status.data;
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

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {notice}

      <Card title={t("plan")}>
        <div className="ms-wrap-row" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              className="ms-display"
              style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", lineHeight: 1 }}
            >
              {planName(plan)}
            </span>
            <span className={`ms-badge ms-badge-${STATUS_TONE[planStatus]}`}>
              {t(`status.${planStatus}`)}
            </span>
          </div>
          {canManage ? (
            <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
              {canCheckout ? (
                <>
                  <button
                    type="button"
                    className="ms-btn ms-btn-primary"
                    disabled={busy}
                    onClick={() => startCheckout.mutate({ plan: "pro" })}
                  >
                    <BtnSpinner
                      on={startCheckout.isPending && startCheckout.variables?.plan === "pro"}
                    />
                    {t("upgradePro")}
                  </button>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    disabled={busy}
                    onClick={() => startCheckout.mutate({ plan: "scale" })}
                  >
                    <BtnSpinner
                      on={startCheckout.isPending && startCheckout.variables?.plan === "scale"}
                    />
                    {t("upgradeScale")}
                  </button>
                </>
              ) : null}
              {hasCustomer ? portalButton(t("manage"), "ms-btn-secondary") : null}
            </div>
          ) : null}
        </div>

        <div className="ms-kpi-row" style={{ display: "flex", gap: 48, marginTop: 22 }}>
          <div>
            <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
              {t("dailyLimit")}
            </div>
            <div style={{ marginTop: 6, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
              {dailyLimit === null ? t("unlimited") : fmt.format(dailyLimit)}
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
        {usage.data ? (
          <QuotaRow
            label={usageT("sentToday")}
            hint={usageT("resetsMidnightUtc")}
            used={usage.data.today.accepted}
            limit={usage.data.today.limit}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Skeleton width={40} height={40} radius="50%" />
            <Skeleton width={110} height="1lh" />
          </div>
        )}
      </Card>

      <Card title={t("plansTitle")}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 12,
          }}
        >
          {PLANS.map((p) => (
            <div
              key={p}
              style={{
                padding: "14px 16px",
                borderRadius: 12,
                border: `1px solid ${p === plan ? "var(--ms-steel)" : "var(--ms-line)"}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="ms-display" style={{ fontSize: 16, color: "var(--ms-bone)" }}>
                  {planName(p)}
                </span>
                {p === plan ? (
                  <span className="ms-badge ms-badge-neutral">{t("current")}</span>
                ) : null}
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: "var(--ms-muted)" }}>
                {limitLabel(PLAN_DAILY_LIMIT[p])}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
