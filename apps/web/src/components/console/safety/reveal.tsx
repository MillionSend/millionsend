"use client";

import {
  CONTENT_REVEAL_JUSTIFICATION_MAX,
  CONTENT_REVEAL_JUSTIFICATION_MIN,
  CONTENT_REVEAL_ONE_MESSAGE_REASONS,
  CONTENT_REVEAL_REASONS,
  type ContentRevealReason,
  type RevealSpan,
} from "@millionsend/core/content-reveal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useId, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { formatDayTime, formatMmSs } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { useCountdown } from "@/lib/use-countdown";

/** The team a grant is about, as both console screens carry it. */
export interface RevealTeam {
  id: string;
  name: string;
}

/** One flagged email, enough for the dialog's lead line. */
export interface RevealEmail {
  id: string;
  from: string;
  sentAt: Date | null;
  recipients: number;
}

export interface RevealGrant {
  id: string;
  emailIds: string[];
  expiresAt: Date;
}

export interface RevealRequest {
  team: RevealTeam;
  /** The row's email, or null when the entry point knows only the team. */
  email: RevealEmail | null;
  /** How many emails a whole-window grant would cover; 0 when unknown. */
  flaggedCount: number;
  /** The flag's own label, which opens the justification for the operator. */
  flagLabel: string;
}

export interface ContentReveal {
  request(input: RevealRequest): void;
  view(team: RevealTeam, grantId: string, emailId: string): void;
  /** Render once per screen: the dialog and the revealed view. */
  dialogs: React.ReactNode;
}

type Stage =
  | { kind: "dialog"; request: RevealRequest }
  | { kind: "view"; team: RevealTeam; grantId: string; emailId: string };

/**
 * Break-glass content access, behind one hook so the review page and the
 * Trust & safety list open the same two dialogs. `onChanged` re-fetches the
 * caller's data after a grant; `onClearFlag` is the review page's own
 * clearFlag, and `onSuspend` its suspend dialog — a screen that has neither
 * leaves them out and the revealed view shows only Close.
 */
export function useContentReveal(opts: {
  onChanged: () => void;
  /** False hides the clear button: there is no open flag to clear. */
  canClearFlag?: boolean | undefined;
  onClearFlag?: ((grantId: string) => void) | undefined;
  onSuspend?: ((team: RevealTeam) => void) | undefined;
}): ContentReveal {
  const t = useTranslations("console.safety.reveal");
  const [stage, setStage] = useState<Stage | null>(null);
  const trpc = useTRPC();
  const close = useCallback(() => setStage(null), []);
  const request = useMutation(trpc.console.safety.requestAccess.mutationOptions());

  const submit = (
    input: RevealRequest,
    values: {
      reason: ContentRevealReason;
      justification: string;
      scope: "email" | "flagged_window";
    },
  ) => {
    request.mutate(
      {
        teamId: input.team.id,
        reason: values.reason,
        justification: values.justification,
        scope: values.scope,
        ...(values.scope === "email" && input.email ? { emailId: input.email.id } : {}),
      },
      {
        onSuccess: (granted) => {
          toast(t("toast.granted", { team: input.team.name }));
          if (granted.refused.length > 0) {
            toast(t("toast.purged", { count: granted.refused.length }), "danger");
          }
          opts.onChanged();
          const first = granted.emailIds[0];
          if (first) {
            setStage({ kind: "view", team: input.team, grantId: granted.grantId, emailId: first });
          } else {
            close();
          }
        },
        onError: (error) => {
          const known: Record<string, string> = {
            off: "toast.failedOff",
            purged: "toast.failedPurged",
            not_flagged: "toast.failedNotFlagged",
          };
          const key = known[error.message];
          toast(key ? t(key) : t("toast.failed", { message: error.message }), "danger");
        },
      },
    );
  };

  return {
    request: (input) => setStage({ kind: "dialog", request: input }),
    view: (team, grantId, emailId) => setStage({ kind: "view", team, grantId, emailId }),
    dialogs:
      stage === null ? null : stage.kind === "dialog" ? (
        <RevealDialog
          request={stage.request}
          pending={request.isPending}
          onClose={close}
          onSubmit={(values) => submit(stage.request, values)}
        />
      ) : (
        <RevealedView
          team={stage.team}
          grantId={stage.grantId}
          emailId={stage.emailId}
          onClose={close}
          {...(opts.onClearFlag && opts.canClearFlag !== false
            ? {
                onClear: () => {
                  close();
                  opts.onClearFlag?.(stage.grantId);
                },
              }
            : {})}
          {...(opts.onSuspend
            ? {
                onSuspend: () => {
                  close();
                  opts.onSuspend?.(stage.team);
                },
              }
            : {})}
        />
      ),
  };
}

function RevealDialog({
  request,
  pending,
  onClose,
  onSubmit,
}: {
  request: RevealRequest;
  pending: boolean;
  onClose: () => void;
  onSubmit: (values: {
    reason: ContentRevealReason;
    justification: string;
    scope: "email" | "flagged_window";
  }) => void;
}) {
  const t = useTranslations("console.safety.reveal.dialog");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const id = useId();
  const [reason, setReason] = useState<ContentRevealReason>("phishing_or_malware");
  const [justification, setJustification] = useState("");
  const { email } = request;
  const windowOnly = email === null;
  const [scope, setScope] = useState<"email" | "flagged_window">(
    windowOnly ? "flagged_window" : "email",
  );
  const short = justification.trim().length < CONTENT_REVEAL_JUSTIFICATION_MIN;
  const oneMessage = CONTENT_REVEAL_ONE_MESSAGE_REASONS.includes(reason);
  const reasons = windowOnly
    ? CONTENT_REVEAL_REASONS.filter((key) => !CONTENT_REVEAL_ONE_MESSAGE_REASONS.includes(key))
    : CONTENT_REVEAL_REASONS;

  function submit() {
    if (pending || short) return;
    onSubmit({
      reason,
      justification: justification.trim(),
      scope: oneMessage ? "email" : scope,
    });
  }

  const windowLabel =
    request.flaggedCount > 0
      ? t("scopeWindow", { count: request.flaggedCount })
      : t("scopeWindowAll");

  return (
    <Modal open onClose={onClose} onConfirm={submit} title={t("title")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p style={{ margin: "6px 0 16px", color: "var(--ms-muted)", fontSize: 13.5 }}>
          {email
            ? t("lead", {
                team: request.team.name,
                from: email.from,
                sent: email.sentAt ? formatDayTime(email.sentAt, locale) : common("none"),
                recipients: email.recipients,
              })
            : t("leadTeam", { team: request.team.name })}
        </p>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-reason`}>{t("reason")}</label>
          <Select
            id={`${id}-reason`}
            value={reason}
            onChange={(next) => setReason(next as ContentRevealReason)}
            ariaLabel={t("reason")}
            width="100%"
            disabled={pending}
            options={reasons.map((key) => ({
              value: key,
              label: t(`reasons.${key}`),
            }))}
          />
        </div>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-why`}>{t("why")}</label>
          <textarea
            id={`${id}-why`}
            className="ms-input"
            style={{ width: "100%", minHeight: 76, resize: "vertical" }}
            maxLength={CONTENT_REVEAL_JUSTIFICATION_MAX}
            disabled={pending}
            placeholder={t("whyPlaceholder")}
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
          />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
            {t("whyHelper", { reason: request.flagLabel })}
          </p>
          {short && justification.length > 0 ? (
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ms-warn)" }}>
              {t("whyShort", { min: CONTENT_REVEAL_JUSTIFICATION_MIN })}
            </p>
          ) : null}
        </div>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-scope`}>{t("scope")}</label>
          {windowOnly ? (
            <p id={`${id}-scope`} style={{ margin: 0, fontSize: 13 }}>
              {windowLabel}
              <span
                className="sub"
                style={{ display: "block", color: "var(--ms-muted)", fontSize: 12 }}
              >
                {t("scopeWindowSub")}
              </span>
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label className="ms-radio-card">
                <input
                  id={`${id}-scope`}
                  type="radio"
                  name={`${id}-scope-group`}
                  checked={oneMessage || scope === "email"}
                  disabled={pending}
                  onChange={() => setScope("email")}
                />
                <span>
                  {t("scopeEmail")}
                  <div className="sub">{t("scopeEmailSub")}</div>
                </span>
              </label>
              {request.flaggedCount > 1 && !oneMessage ? (
                <label className="ms-radio-card">
                  <input
                    type="radio"
                    name={`${id}-scope-group`}
                    checked={scope === "flagged_window"}
                    disabled={pending}
                    onChange={() => setScope("flagged_window")}
                  />
                  <span>
                    {windowLabel}
                    <div className="sub">{t("scopeWindowSub")}</div>
                  </span>
                </label>
              ) : null}
            </div>
          )}
        </div>
        <div className="ms-grid ms-grid-12" style={{ marginBottom: 14, fontSize: 13 }}>
          <div>
            <div className="ms-microlabel">{t("window")}</div>
            {t("windowValue")}
          </div>
          <div>
            <div className="ms-microlabel">{t("recorded")}</div>
            {t("recordedValue")}
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--ms-muted)" }}>{t("note")}</p>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={pending || short}>
            <BtnSpinner on={pending} />
            {t("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** The monitor's answer for one email as a sentence, or why it has none. */
function verdictLine(
  verdict: { status: string; score: number | null; reasons: unknown; errorClass: string | null },
  monitorT: (key: string, values?: Record<string, string>) => string,
): string {
  if (verdict.status === "pending") return monitorT("pending");
  if (verdict.status !== "judged") {
    return verdict.errorClass
      ? monitorT("unjudged", { error: verdict.errorClass })
      : monitorT("unjudgedNoError");
  }
  const reasons = Array.isArray(verdict.reasons) ? (verdict.reasons as string[]) : [];
  return reasons.length > 0
    ? `${verdict.score ?? "—"} · ${reasons.join(", ")}`
    : `${verdict.score ?? "—"}`;
}

/** Where a span starts: the body is one immutable string, so an offset is identity. */
function keyedSpans(spans: RevealSpan[]): { key: string; span: RevealSpan }[] {
  let offset = 0;
  return spans.map((span) => {
    const key = String(offset);
    offset += span.text.length;
    return { key, span };
  });
}

/**
 * The revealed view: subject and redacted rendered text, a live countdown to
 * the grant's own expiry, and the two decisions that end a review. The query
 * is asked once — every view is counted on the grant, so a refetch on focus
 * would inflate the record of how often the content was read.
 */
function RevealedView({
  team,
  grantId,
  emailId,
  onClose,
  onClear,
  onSuspend,
}: {
  team: RevealTeam;
  grantId: string;
  emailId: string;
  onClose: () => void;
  onClear?: (() => void) | undefined;
  onSuspend?: (() => void) | undefined;
}) {
  const t = useTranslations("console.safety.reveal.view");
  const monitorT = useTranslations("console.safety.review.monitor");
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.console.safety.revealed.queryOptions({ grantId, emailId }),
    // Every view is counted on the grant, so a focus refetch must not inflate
    // the record — and nothing of the body outlives the closed dialog, which
    // also makes reopening it the second view it is.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    gcTime: 0,
    retry: false,
  });
  const left = useCountdown(query.data?.expiresAt ?? null);
  const expired = query.data !== undefined && left === 0;
  const errorMessage = query.error?.message;

  return (
    <Modal open onClose={onClose} size="wide" title={t("title", { team: team.name })}>
      <p style={{ margin: "6px 0 14px", color: "var(--ms-muted)", fontSize: 13.5 }}>{t("lead")}</p>
      {query.isPending ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>…</p>
      ) : expired ? (
        // "30 minutes, then hidden again" is the promise; an open dialog that
        // outlives its window must hide what it already fetched.
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-warn)" }}>{t("expired")}</p>
      ) : query.isError ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-danger)" }}>
          {errorMessage === "expired"
            ? t("expired")
            : errorMessage === "purged"
              ? t("purged")
              : t("failed")}
        </p>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <span className="ms-chip">{t("expires", { time: formatMmSs(left) })}</span>
            <span className="ms-chip">{t("renderedOnly")}</span>
            <span className="ms-chip">{t("recipientsHidden")}</span>
            <span className="ms-chip">{t("noExport")}</span>
            {query.data.redactions > 0 ? (
              <span className="ms-chip">{t("redactions", { count: query.data.redactions })}</span>
            ) : null}
          </div>
          <div className="ms-microlabel" style={{ marginBottom: 4 }}>
            {t("subject")}
          </div>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>
            {keyedSpans(query.data.subject).map(({ key, span }) => (
              <span key={key} className={span.redacted ? "ms-redact" : undefined}>
                {span.text}
              </span>
            ))}
          </div>
          <div className="ms-microlabel" style={{ marginBottom: 4 }}>
            {t("body")}
          </div>
          <div className="ms-revealed">
            {query.data.spans.length === 0 ? (
              <span style={{ color: "var(--ms-muted)" }}>{t("empty")}</span>
            ) : (
              keyedSpans(query.data.spans).map(({ key, span }) => (
                <span key={key} className={span.redacted ? "ms-redact" : undefined}>
                  {span.text}
                </span>
              ))
            )}
          </div>
          <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {query.data.verdict
              ? t("verdict", { verdict: verdictLine(query.data.verdict, monitorT) })
              : t("verdictNone")}
          </p>
        </>
      )}
      <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>{t("note")}</p>
      <ModalFooter>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
          {t("close")} <span className="ms-keycap">Esc</span>
        </button>
        {onClear ? (
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClear}>
            {t("clear")}
          </button>
        ) : null}
        {onSuspend ? (
          <button type="button" className="ms-btn ms-btn-destructive" onClick={onSuspend}>
            {t("suspend")}
          </button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}

/**
 * A flagged row's content cell: Reveal while no grant covers it, and the
 * grant's own countdown beside an Open button while one does.
 */
export function RevealCell({
  grant,
  disabled,
  onReveal,
  onOpen,
}: {
  grant: RevealGrant | undefined;
  disabled: boolean;
  onReveal: () => void;
  onOpen: (grantId: string) => void;
}) {
  const t = useTranslations("console.safety.reveal");
  const left = useCountdown(grant?.expiresAt ?? null);
  if (grant && left > 0) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span className="ms-chip" style={{ whiteSpace: "nowrap" }}>
          {t("left", { time: formatMmSs(left) })}
        </span>
        <button
          type="button"
          className="ms-btn ms-btn-secondary ms-btn-sm"
          onClick={() => onOpen(grant.id)}
        >
          {t("open")}
        </button>
      </span>
    );
  }
  const button = (
    <button
      type="button"
      className="ms-btn ms-btn-secondary ms-btn-sm"
      disabled={disabled}
      onClick={onReveal}
    >
      {t("row")}
    </button>
  );
  // A native title never shows on a disabled button, so the reason rides the
  // console's own tooltip instead.
  return disabled ? (
    <Tooltip inline text={t("off")}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
