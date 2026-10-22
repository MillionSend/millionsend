"use client";

import type { LimitRequestSends, LimitRequestSource, NewDomainLimit } from "@millionsend/core";
import {
  LIMIT_REQUEST_NOTE_MAX,
  LIMIT_REQUEST_PER_DAY_MAX,
  limitSpent,
} from "@millionsend/core/limit-rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { bannerLinkStyle, GradientBanner } from "@/components/gradient-banner";
import { HourglassIcon } from "@/components/icons/warmup-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { StatBlock, StatStrip } from "@/components/stat-block";
import { StepRail } from "@/components/step-rail";
import { toast } from "@/components/toast";
import { PaceBand } from "@/components/warmup-rail";
import {
  daysSince,
  daysUntil,
  formatDay,
  formatHoursMinutes,
  formatStepDay,
  formatTime,
} from "@/lib/format";
import { bindingFigures, limitRailSteps } from "@/lib/new-domain-limit";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";

// In the order the dialog offers them; the router's input takes the enums themselves.
const SENDS = [
  "account",
  "notifications",
  "marketing",
  "mix",
] as const satisfies readonly LimitRequestSends[];
const SOURCES = [
  "new",
  "other_provider",
  "own_servers",
] as const satisfies readonly LimitRequestSource[];

/** A team's latest request for the domain, as the page shows it: never who decided. */
export interface LimitRequestView {
  status: "open" | "granted" | "declined";
  createdAt: Date;
  resolvedAt: Date | null;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--ms-bone)",
  margin: "0 0 6px",
};

/** The warn line in the status rows while the limit holds this domain's mail. */
export function LimitWaitingBanner({ limit }: { limit: NewDomainLimit }) {
  const t = useTranslations("domains");
  const locale = useLocale();
  if (limit.waiting === 0) return null;
  const nf = new Intl.NumberFormat(locale);
  const spent = limitSpent(limit);
  const values = {
    count: limit.waiting,
    duration: formatHoursMinutes(new Date(limit.resetsAt).getTime() - Date.now()),
  };
  const waitingEmails = new URLSearchParams({
    domain: limit.domainId,
    status: "queued_quota",
    source: "all",
    range: "all",
  });
  return (
    <GradientBanner
      variant="warn"
      icon={<HourglassIcon />}
      title={t("detail.limit.waitingTitle", { count: limit.waiting })}
      action={
        <Link href={`/emails?${waitingEmails}`} style={bannerLinkStyle}>
          {t("detail.limit.seeWaiting")}
        </Link>
      }
    >
      {spent === "pool" && limit.pool
        ? t("detail.limit.waitingPool", { ...values, cap: nf.format(limit.pool.cap) })
        : spent
          ? t("detail.limit.waitingSpent", { ...values, cap: nf.format(limit.cap) })
          : t("detail.limit.waitingSoon", { count: limit.waiting })}
    </GradientBanner>
  );
}

/**
 * The new domain limit on the domain page: today's figures, how the limit
 * grows, and the way to ask for more. Only volumes and dates, never why.
 */
export function LimitSection({
  domainId,
  domain,
  limit,
  request,
  canManage,
}: {
  domainId: string;
  domain: string;
  limit: NewDomainLimit;
  request: LimitRequestView | null;
  canManage: boolean;
}) {
  const t = useTranslations("domains");
  const locale = useLocale();
  const [asking, setAsking] = useState(false);
  const nf = new Intl.NumberFormat(locale);
  const spent = limitSpent(limit);
  const today = bindingFigures(limit);
  const nextStep = limit.steps.slice(1).find((step) => step.cap !== null);
  const note = [
    limit.pool
      ? t("detail.limit.shared", {
          domains: nf.format(limit.pool.domains),
          cap: nf.format(limit.pool.cap),
        })
      : null,
    t(limit.steps.length > 0 ? "detail.limit.note" : "detail.limit.noteUnknown"),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section style={{ marginTop: 28, maxWidth: 1000 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          margin: "0 0 12px",
        }}
      >
        <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
          {t("detail.limit.section")}
        </div>
        {limit.registeredAt ? (
          <span style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
            {t("detail.limit.registered", { days: daysSince(limit.registeredAt) })}
          </span>
        ) : null}
      </div>
      <StatStrip>
        <StatBlock
          label={t("detail.limit.sentToday")}
          value={nf.format(today.used)}
          hint={t(spent === "pool" ? "detail.limit.sentHintShared" : "detail.limit.sentHint", {
            cap: nf.format(today.cap),
            time: formatTime(limit.resetsAt, locale),
          })}
        />
        <StatBlock
          label={t("detail.limit.waiting")}
          value={nf.format(limit.waiting)}
          hint={t(spent ? "detail.limit.waitingHint" : "detail.limit.waitingHintSoon", {
            count: limit.waiting,
          })}
        />
        {nextStep?.cap ? (
          <StatBlock
            label={t("detail.limit.from", { day: formatStepDay(nextStep.from, locale) })}
            value={nf.format(nextStep.cap)}
            hint={t("detail.limit.aDay")}
          />
        ) : null}
        {limit.fullAt ? (
          <StatBlock
            label={t("detail.limit.noLimitFrom")}
            value={formatDay(limit.fullAt, locale)}
            plain
            hint={t("detail.limit.noLimitHint", { days: daysUntil(limit.fullAt) })}
          />
        ) : null}
      </StatStrip>
      {limit.steps.length > 0 ? (
        <PaceBand label={t("detail.limit.rail")} note={note} style={{ borderTop: 0 }}>
          <StepRail steps={limitRailSteps(limit, t, locale)} label={t("detail.limit.rail")} />
        </PaceBand>
      ) : (
        <div className="ms-pacing" style={{ borderTop: 0 }}>
          <p>{note}</p>
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "20px 0 0",
          borderTop: "1px solid var(--ms-line)",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: "var(--ms-bone)", margin: 0 }}>
            {t("detail.limit.askTitle")}
          </h3>
          <p
            style={{ fontSize: 12.5, color: "var(--ms-muted)", margin: "6px 0 0", lineHeight: 1.5 }}
          >
            {request?.status === "declined"
              ? t("detail.limit.askDeclined", { date: formatDay(request.createdAt, locale) })
              : t("detail.limit.askBody")}
          </p>
        </div>
        {request?.status === "open" ? (
          <span style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
            {t("detail.limit.askSent", { date: formatDay(request.createdAt, locale) })}
          </span>
        ) : canManage ? (
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => setAsking(true)}>
            {t("detail.limit.askButton")}
          </button>
        ) : null}
      </div>
      <AskDialog
        open={asking}
        onClose={() => setAsking(false)}
        domainId={domainId}
        domain={domain}
        cap={limit.cap}
      />
    </section>
  );
}

/** What the team sends, how much and from where: the operator reviews the limit from it. */
function AskDialog({
  open,
  onClose,
  domainId,
  domain,
  cap,
}: {
  open: boolean;
  onClose: () => void;
  domainId: string;
  domain: string;
  cap: number;
}) {
  const t = useTranslations("domains");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [sends, setSends] = useState<LimitRequestSends>("account");
  const [perDay, setPerDay] = useState("");
  const [source, setSource] = useState<LimitRequestSource>("new");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const ask = useMutation(
    trpc.domains.requestHigherLimit.mutationOptions({
      onSuccess: () => {
        setTried(false);
        onClose();
        toast(t("detail.limit.ask.sent"));
      },
      // A refusal can mean the page is behind: a request already open, or the limit gone.
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id: domainId }) }),
    }),
  );
  const count = Number(perDay.replace(/\D/g, ""));
  const countValid =
    Number.isSafeInteger(count) && count >= 1 && count <= LIMIT_REQUEST_PER_DAY_MAX;
  const close = () => {
    ask.reset();
    setTried(false);
    onClose();
  };
  const submit = () => {
    setTried(true);
    if (!countValid || ask.isPending) return;
    ask.mutate({
      id: domainId,
      sends,
      perDay: count,
      source,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };
  const code = ask.isError ? trpcErrorCode(ask.error) : null;
  const error = !ask.isError
    ? null
    : code === "CONFLICT"
      ? t("detail.limit.ask.errors.already")
      : code === "PRECONDITION_FAILED"
        ? t("detail.limit.ask.errors.notLimited")
        : code === "BAD_REQUEST"
          ? t("detail.limit.ask.errors.invalid")
          : t("detail.limit.ask.errors.failed");
  return (
    <Modal open={open} onClose={close} onConfirm={submit} title={t("detail.limit.ask.title")}>
      <p style={{ margin: "0 0 20px", fontSize: 14, color: "var(--ms-muted)", lineHeight: 1.5 }}>
        {t("detail.limit.ask.intro", { domain, cap: new Intl.NumberFormat(locale).format(cap) })}
      </p>
      <div style={{ display: "grid", gap: 16 }}>
        <div>
          <label htmlFor="limit-ask-sends" style={labelStyle}>
            {t("detail.limit.ask.sends")}
          </label>
          <Select
            id="limit-ask-sends"
            value={sends}
            onChange={(value) => setSends(value as LimitRequestSends)}
            ariaLabel={t("detail.limit.ask.sends")}
            width="100%"
            options={SENDS.map((value) => ({
              value,
              label: t(`detail.limit.ask.sendsOptions.${value}`),
            }))}
          />
        </div>
        <div className="ms-grid ms-grid-short-long" style={{ gap: 12 }}>
          <div>
            <label htmlFor="limit-ask-per-day" style={labelStyle}>
              {t("detail.limit.ask.perDay")}
            </label>
            <input
              id="limit-ask-per-day"
              className="ms-input mono"
              inputMode="numeric"
              autoComplete="off"
              style={{ width: "100%", boxSizing: "border-box" }}
              aria-invalid={tried && !countValid}
              value={perDay}
              onChange={(event) => setPerDay(event.target.value)}
            />
            {tried && !countValid ? (
              <span className="ms-field-error" style={{ margin: "6px 0 0" }}>
                {t("detail.limit.ask.perDayError", {
                  max: new Intl.NumberFormat(locale).format(LIMIT_REQUEST_PER_DAY_MAX),
                })}
              </span>
            ) : null}
          </div>
          <div>
            <label htmlFor="limit-ask-source" style={labelStyle}>
              {t("detail.limit.ask.source")}
            </label>
            <Select
              id="limit-ask-source"
              value={source}
              onChange={(value) => setSource(value as LimitRequestSource)}
              ariaLabel={t("detail.limit.ask.source")}
              width="100%"
              options={SOURCES.map((value) => ({
                value,
                label: t(`detail.limit.ask.sourceOptions.${value}`),
              }))}
            />
          </div>
        </div>
        <div>
          <label htmlFor="limit-ask-note" style={labelStyle}>
            {t("detail.limit.ask.note")}{" "}
            <span style={{ fontWeight: 400, color: "var(--ms-muted)" }}>
              {t("detail.limit.ask.optional")}
            </span>
          </label>
          <textarea
            id="limit-ask-note"
            className="ms-input"
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              height: "auto",
              minHeight: 76,
              resize: "none",
              font: "inherit",
              fontSize: 14,
            }}
            maxLength={LIMIT_REQUEST_NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p
          style={{ margin: "14px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}
        >
          {error}
        </p>
      ) : null}
      <ModalFooter>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
          {common("cancel")} <span className="ms-keycap">Esc</span>
        </button>
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={ask.isPending}
          onClick={submit}
        >
          <BtnSpinner on={ask.isPending} />
          {t("detail.limit.ask.submit")} <ConfirmKeycap />
        </button>
      </ModalFooter>
    </Modal>
  );
}
