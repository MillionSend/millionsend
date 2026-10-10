"use client";

import { AUDIT_ACTIONS } from "@millionsend/core/audit-actions";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { type DomainRegion, regionFlag } from "@/app/(dashboard)/domains/regions";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { formatDay, formatDayTime, formatRelative } from "@/lib/format";
import { formatRisk, riskColor } from "@/lib/monitor-settings";
import { formatScoreTenths } from "@/lib/score-band";
import { useTRPC } from "@/lib/trpc";
import { useTeamActions } from "../team-actions";
import {
  CardHead,
  LoadErrorCard,
  ReasonLabel,
  scoreColor,
  usePercent,
  usePlanLabel,
} from "./parts";
import { RevealCell, useContentReveal } from "./reveal";

const TILE: React.CSSProperties = { padding: "16px 20px" };
// The monitoring rows are sentences, not figures: sans, left, the body size.
const KV_VALUE: React.CSSProperties = {
  textAlign: "left",
  fontFamily: "var(--ms-font-sans)",
  fontSize: 13,
};
const SEVERITY_DOT: Record<string, string> = {
  critical: "var(--ms-danger)",
  major: "var(--ms-danger)",
  minor: "var(--ms-warn)",
};

export function ReviewView({ teamId }: { teamId: string }) {
  const t = useTranslations("console.safety.review");
  const safety = useTranslations("console.safety");
  const common = useTranslations("console.common");
  const auditT = useTranslations("console.audit");
  const settings = useTranslations("settings");
  const emails = useTranslations("emails");
  const domains = useTranslations("domains");
  const locale = useLocale();
  const percent = usePercent();
  const planLabel = usePlanLabel();
  const trpc = useTRPC();
  const nf = new Intl.NumberFormat(locale);

  const query = useQuery(trpc.console.safety.review.queryOptions({ teamId }));
  const refetch = () => {
    query.refetch();
  };
  const actions = useTeamActions(refetch);
  const clear = useMutation(trpc.console.safety.clearFlag.mutationOptions());
  const reopen = useMutation(trpc.console.safety.reopenFlag.mutationOptions());
  const open = useMutation(trpc.console.safety.openFlag.mutationOptions());
  const setOverride = useMutation(trpc.console.monitor.setOverride.mutationOptions());
  const clearOverride = useMutation(trpc.console.monitor.clearOverride.mutationOptions());
  const resumeMonitor = useMutation(trpc.console.monitor.resumeBroadcasts.mutationOptions());
  const monitorT = useTranslations("console.safety.review.monitor");
  const tiers = useTranslations("console.safety.tiers");

  const revealT = useTranslations("console.safety.reveal");
  const reveal = useContentReveal({
    onChanged: refetch,
    // Offered only while a flag is open: a button that closes the dialog and
    // does nothing would be worse than no button.
    canClearFlag: query.data?.flag?.status === "open",
    onClearFlag: (grantId) => {
      const data = query.data;
      if (data?.flag?.status !== "open") return;
      clear.mutate(
        { flagId: data.flag.id, afterGrantId: grantId },
        {
          onSuccess: () => {
            toast(revealT("toast.cleared", { team: data.team.name }));
            refetch();
          },
        },
      );
    },
    onSuspend: () => {
      const data = query.data;
      if (!data) return;
      actions.suspend({
        id: data.team.id,
        name: data.team.name,
        plan: data.team.plan,
        planQuota: data.team.planQuota,
        suspendedAt: data.team.suspendedAt,
        suspensionReason: data.team.suspensionReason,
        broadcastsPausedByOperatorAt: data.team.broadcastsPausedByOperatorAt,
      });
    },
  });
  const [flagDialog, setFlagDialog] = useState(false);
  const [note, setNote] = useState("");
  const closeFlagDialog = useCallback(() => {
    setFlagDialog(false);
    setNote("");
  }, []);

  if (query.isError) return <LoadErrorCard onRetry={refetch} />;
  if (query.isPending) return <ReviewSkeleton />;

  const { team, flag, standing, checks, flaggedEmails, audit, monitor, grants, contentReveal } =
    query.data;
  const grantFor = (emailId: string) => grants.find((g) => g.emailIds.includes(emailId));
  const revealRequest = (email: (typeof flaggedEmails)[number] | null) => () =>
    reveal.request({
      team: { id: team.id, name: team.name },
      email: email
        ? { id: email.id, from: email.from, sentAt: email.sentAt, recipients: email.recipients }
        : null,
      flaggedCount: flaggedEmails.length,
      flagLabel: safety(`reasons.${flag?.reason ?? "manual"}`),
    });
  const exempt = monitor.tier === "exempt";
  const modelDetail = (reasons: string[] | null) => () =>
    reasons ? <ReasonCodes codes={reasons} /> : t("emails.notFlagged");
  const percentRate = (rate: number) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(rate);
  const monitorDone = (key: "override" | "overrideCleared" | "resumed") => () => {
    toast(monitorT(`toast.${key}`, { team: team.name }));
    refetch();
  };
  const monitorBusy = setOverride.isPending || clearOverride.isPending || resumeMonitor.isPending;
  const target = {
    id: team.id,
    name: team.name,
    plan: team.plan,
    planQuota: team.planQuota,
    suspendedAt: team.suspendedAt,
    suspensionReason: team.suspensionReason,
    broadcastsPausedByOperatorAt: team.broadcastsPausedByOperatorAt,
  };
  const owner = team.owners[0]?.email ?? common("none");
  const proofValues = {
    plan: planLabel(team.plan, team.planQuota),
    region: team.region
      ? `${regionFlag(team.region)} ${domains(`regions.${team.region as DomainRegion}`)}`
      : common("unknownRegion"),
    domains: team.domains,
    owner,
  };
  const subtitle = (
    <>
      {flag?.status === "open"
        ? t("proof", { ...proofValues, since: formatRelative(flag.openedAt, locale) })
        : t("proofNoFlag", proofValues)}{" "}
      · <CopyChip value={team.id} wrap />
    </>
  );
  const flagOpen = flag?.status === "open";
  const submitFlag = () => {
    if (!note.trim() || open.isPending) return;
    open.mutate(
      { teamId: team.id, note: note.trim() },
      {
        onSuccess: () => {
          closeFlagDialog();
          toast(safety("toast.flagged", { team: team.name }));
          refetch();
        },
      },
    );
  };

  const heldForReview = team.suspensionReason === "review";
  const standingBadge = heldForReview
    ? ["warn", t("badges.heldForReview")]
    : team.suspendedAt
      ? ["danger", t("badges.suspended")]
      : standing.guardrail === "paused"
        ? ["danger", t("badges.guardrailPaused")]
        : standing.guardrail === "warning"
          ? ["warn", t("badges.guardrailWarning")]
          : ["neutral", t("badges.guardrailOk")];

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/console/safety" label={t("crumb")} />
            <CrumbEnd label={team.name} />
          </>
        }
        title={team.name}
        subtitle={subtitle}
        actions={
          <>
            <span className={`ms-badge ms-badge-${standingBadge[0]}`}>{standingBadge[1]}</span>
            {team.broadcastsPausedByOperatorAt ? (
              <span className="ms-badge ms-badge-warn">{t("badges.operatorPaused")}</span>
            ) : null}
            {flag ? (
              <span className={`ms-badge ms-badge-${flagOpen ? "warn" : "neutral"}`}>
                {t(flagOpen ? "badges.flagOpen" : "badges.flagCleared")}
              </span>
            ) : null}
            <RequestAccessButton
              on={contentReveal}
              disabled={!contentReveal || flaggedEmails.length === 0}
              label={revealT("request")}
              off={revealT("off")}
              onClick={revealRequest(flaggedEmails[0] ?? null)}
            />
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={() =>
                team.broadcastsPausedByOperatorAt
                  ? actions.resumeBroadcasts(target)
                  : actions.pauseBroadcasts(target)
              }
            >
              {safety(team.broadcastsPausedByOperatorAt ? "menu.resume" : "menu.pause")}
            </button>
            {flag ? (
              <Tooltip
                inline
                focusableChild
                text={safety(
                  !flagOpen
                    ? "menu.reopenTip"
                    : flag.reason === "manual"
                      ? "menu.clearManualTip"
                      : "menu.clearTip",
                )}
              >
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={clear.isPending || reopen.isPending}
                  onClick={() => {
                    const done = (key: "cleared" | "reopened") => () => {
                      toast(safety(`toast.${key}`, { team: team.name }));
                      refetch();
                    };
                    if (flagOpen) clear.mutate({ flagId: flag.id }, { onSuccess: done("cleared") });
                    else reopen.mutate({ flagId: flag.id }, { onSuccess: done("reopened") });
                  }}
                >
                  <BtnSpinner on={clear.isPending || reopen.isPending} />
                  {safety(flagOpen ? "menu.clear" : "menu.reopen")}
                </button>
              </Tooltip>
            ) : null}
            <PopoverMenu
              boxed
              ariaLabel={common("actions")}
              items={[
                ...(heldForReview
                  ? [
                      { label: safety("menu.release"), onSelect: () => actions.reinstate(target) },
                      {
                        label: safety("menu.convert"),
                        danger: true,
                        onSelect: () => actions.suspend(target),
                      },
                    ]
                  : [
                      team.suspendedAt
                        ? {
                            label: safety("menu.reinstate"),
                            onSelect: () => actions.reinstate(target),
                          }
                        : {
                            label: safety("menu.suspend"),
                            danger: true,
                            onSelect: () => actions.suspend(target),
                          },
                    ]),
                ...(flagOpen
                  ? []
                  : [{ label: t("openFlag"), onSelect: () => setFlagDialog(true) }]),
              ]}
            />
          </>
        }
      />

      <div className="ms-grid ms-grid-tiles" style={{ marginBottom: 16 }}>
        <Tile
          label={
            <Tooltip inline text={t("tiles.riskTip")}>
              {t("tiles.risk")}
            </Tooltip>
          }
          color={
            monitor.risk === null
              ? undefined
              : riskColor(monitor.risk, monitor.flagRisk, monitor.alertRisk)
          }
        >
          {exempt
            ? t("tiles.riskExempt")
            : monitor.risk === null
              ? common("none")
              : formatRisk(monitor.risk)}
        </Tile>
        <Tile
          label={
            <Tooltip inline text={t("tiles.scoreTip")}>
              {t("tiles.score")}
            </Tooltip>
          }
          color={standing.scoreTenths === null ? undefined : scoreColor(standing.scoreTenths)}
        >
          {standing.scoreTenths === null
            ? common("none")
            : t("tiles.scoreOf", { score: formatScoreTenths(standing.scoreTenths, locale) })}
        </Tile>
        <Tile label={t("tiles.complaints")}>{percent(standing.complaintRate7d)}</Tile>
        <Tile label={t("tiles.bounces")}>{percent(standing.hardBounceRate7d)}</Tile>
        <Tile label={t("tiles.sent7d")}>{nf.format(standing.sent7d)}</Tile>
        <Tile label={t("tiles.contacts")}>{nf.format(team.contacts)}</Tile>
      </div>

      <div className="ms-card" style={{ padding: 20, marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <CardHead flush title={monitorT("title")} subtitle={monitorT("subtitle")} />
          </div>
          {!exempt ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {monitor.broadcastsPausedAt ? (
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={monitorBusy}
                  onClick={() =>
                    resumeMonitor.mutate({ teamId: team.id }, { onSuccess: monitorDone("resumed") })
                  }
                >
                  <BtnSpinner on={resumeMonitor.isPending} />
                  {monitorT("resume")}
                </button>
              ) : null}
              {monitor.override ? (
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={monitorBusy}
                  onClick={() =>
                    clearOverride.mutate(
                      { teamId: team.id },
                      { onSuccess: monitorDone("overrideCleared") },
                    )
                  }
                >
                  <BtnSpinner on={clearOverride.isPending} />
                  {monitorT("stopOverride")}
                </button>
              ) : monitor.judge.on ? (
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={monitorBusy}
                  onClick={() =>
                    setOverride.mutate({ teamId: team.id }, { onSuccess: monitorDone("override") })
                  }
                >
                  <BtnSpinner on={setOverride.isPending} />
                  {monitorT("sampleAll")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {!monitor.judge.on && monitor.samples.length === 0 && !monitor.broadcastsPausedAt ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{monitorT("off")}</p>
        ) : exempt ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{monitorT("exempt")}</p>
        ) : (
          <>
            <dl
              className="ms-kv"
              style={{ gridTemplateColumns: "max-content 1fr", marginBottom: 16 }}
            >
              <dt>{monitorT("tier")}</dt>
              <dd style={KV_VALUE}>
                {monitorT("tierValue", {
                  tier: tiers(monitor.tier),
                  rate: percentRate(monitor.decision.rate),
                })}
                {monitor.decision.elevated.length > 0
                  ? ` · ${monitor.decision.elevated.map((e) => monitorT(`elevated.${e}`)).join(" · ")}`
                  : ""}
              </dd>
              <dt>{monitorT("samples")}</dt>
              <dd style={KV_VALUE}>
                {monitorT("samplesValue", {
                  samples: monitor.samples7d,
                  flagged: monitor.flagged7d,
                  unjudged: monitor.unjudged7d,
                })}
              </dd>
              <dt>{monitorT("verdicts")}</dt>
              <dd style={KV_VALUE}>
                {monitor.topReasons.length > 0
                  ? monitorT.rich("verdictsReasons", {
                      clean: monitor.judged7d - monitor.flagged7d,
                      flagged: monitor.flagged7d,
                      reasons: () => <ReasonCodes codes={monitor.topReasons} />,
                    })
                  : monitorT("verdictsValue", {
                      clean: monitor.judged7d - monitor.flagged7d,
                      flagged: monitor.flagged7d,
                    })}
              </dd>
              <dt>{monitorT("lastSample")}</dt>
              <dd style={KV_VALUE}>
                {monitor.lastSampleAt ? (
                  <RelativeTime date={monitor.lastSampleAt} />
                ) : (
                  common("none")
                )}
              </dd>
              <dt>{monitorT("model")}</dt>
              <dd style={KV_VALUE}>
                {monitor.judge.on
                  ? `${monitor.judge.provider} · ${monitor.judge.model}`
                  : monitorT("modelOff")}
              </dd>
              <dt>{monitorT("override")}</dt>
              <dd style={KV_VALUE}>
                {monitor.override
                  ? monitorT("overrideValue", {
                      until: formatDayTime(monitor.override.until, locale),
                    })
                  : monitorT("overrideNone")}
              </dd>
              <dt>{monitorT("pause")}</dt>
              <dd style={KV_VALUE}>
                {monitor.broadcastsPausedAt
                  ? monitorT("pauseValue", {
                      since: formatDayTime(monitor.broadcastsPausedAt, locale),
                    })
                  : monitorT("pauseNone")}
              </dd>
            </dl>
            <CardHead title={monitorT("samplesTitle")} subtitle={monitorT("samplesSubtitle")} />
            <Table>
              <thead>
                <tr>
                  <th>{monitorT("cols.at")}</th>
                  <th>{monitorT("cols.kind")}</th>
                  <th className="right">{monitorT("cols.result")}</th>
                  <th>
                    <Tooltip inline text={monitorT("reasonsTip")}>
                      {monitorT("cols.reasons")}
                    </Tooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {monitor.samples.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--ms-muted)" }}>
                      {monitorT("samplesNone")}
                    </td>
                  </tr>
                ) : (
                  monitor.samples.map((sample) => (
                    <tr key={sample.id}>
                      <td style={{ color: "var(--ms-muted)" }}>
                        <RelativeTime date={sample.createdAt} />
                      </td>
                      <td>{monitorT(`kinds.${sample.kind}`)}</td>
                      <td
                        className="right num"
                        style={{
                          color:
                            sample.status === "judged" && sample.score !== null
                              ? riskColor(sample.score / 100, monitor.flagScore / 100, 0.9)
                              : "var(--ms-muted)",
                        }}
                      >
                        {sample.status === "judged"
                          ? (sample.score ?? common("none"))
                          : sample.status === "pending"
                            ? monitorT("pending")
                            : monitorT("unjudged", { error: sample.errorClass ?? "" })}
                      </td>
                      <td className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                        {sample.reasons?.length ? (
                          <ReasonCodes codes={sample.reasons} />
                        ) : (
                          common("none")
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </>
        )}
      </div>

      <div className="ms-grid ms-grid-12" style={{ marginBottom: 16 }}>
        <div className="ms-card" style={{ padding: 20 }}>
          <CardHead title={t("flagTitle")} />
          {flag ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
              <div>
                <ReasonLabel reason={flag.reason} detail={flag.detail} />
              </div>
              <div style={{ color: "var(--ms-muted)" }}>
                {t(flag.openedBy ? "flagOpenedBy" : "flagOpenedAuto")} ·{" "}
                <RelativeTime date={flag.openedAt} />
              </div>
              {flag.note ? <div>{t("flagNote", { note: flag.note })}</div> : null}
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{common("none")}</p>
          )}
        </div>
        <div className="ms-card" style={{ padding: 20 }}>
          <CardHead title={t("checks.title")} subtitle={t("checks.subtitle")} />
          {checks.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{t("checks.none")}</p>
          ) : (
            checks.map((check, index) => (
              <div
                key={check.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 13,
                  padding: "7px 0",
                  borderTop: index === 0 ? undefined : "1px solid var(--ms-line)",
                }}
              >
                <span
                  className="ms-dot"
                  style={{ background: SEVERITY_DOT[check.severity] ?? "var(--ms-muted)" }}
                />
                <span>{emails(`insights.check.${check.id}.title`)}</span>
                <span
                  className="ms-mono"
                  style={{ marginLeft: "auto", fontSize: 12, color: "var(--ms-muted)" }}
                >
                  {t("checks.count", { emails: check.emails })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="ms-card" style={{ padding: 0, marginBottom: 16 }}>
        <CardHead
          inset
          title={t("emails.title", { count: flaggedEmails.length })}
          subtitle={t("emails.subtitle")}
        />
        <Table>
          <thead>
            <tr>
              <th>{t("emails.sent")}</th>
              <th>{t("emails.from")}</th>
              <th className="right">{t("emails.recipients")}</th>
              <th>{t("emails.insight")}</th>
              <th>{t("emails.monitor")}</th>
              <th className="right">{t("emails.content")}</th>
            </tr>
          </thead>
          <tbody>
            {flaggedEmails.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "var(--ms-muted)" }}>
                  {t("emails.none")}
                </td>
              </tr>
            ) : (
              flaggedEmails.map((email) => (
                <tr key={email.id}>
                  <td style={{ color: "var(--ms-muted)" }}>
                    {email.sentAt ? <RelativeTime date={email.sentAt} /> : common("none")}
                  </td>
                  <td className="ms-mono">{email.from}</td>
                  <td className="right ms-digits">{nf.format(email.recipients)}</td>
                  <td>
                    {email.check ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <Tooltip
                          inline
                          text={emails(`insights.check.${email.check.id}.description`)}
                        >
                          <span
                            className={`ms-badge ms-badge-${email.check.severity === "critical" ? "danger" : "warn"}`}
                          >
                            {emails(`insights.check.${email.check.id}.title`)}
                          </span>
                        </Tooltip>
                        {email.failingCount > 1 ? (
                          <span style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                            {t("emails.more", { count: email.failingCount - 1 })}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      common("none")
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ms-muted)", whiteSpace: "normal" }}>
                    {!email.model
                      ? common("none")
                      : email.model.status === "judged" && email.model.score !== null
                        ? t.rich("emails.modelScore", {
                            score: email.model.score,
                            detail: modelDetail(
                              email.model.score >= monitor.flagScore ? email.model.reasons : null,
                            ),
                          })
                        : email.model.status === "pending"
                          ? monitorT("pending")
                          : t("emails.modelUnjudged", { error: email.model.errorClass ?? "" })}
                  </td>
                  <td className="right">
                    <RevealCell
                      grant={grantFor(email.id)}
                      disabled={!contentReveal}
                      onReveal={revealRequest(email)}
                      onOpen={(grantId) =>
                        reveal.view({ id: team.id, name: team.name }, grantId, email.id)
                      }
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>

      <WarmupCard
        team={{ id: team.id, name: team.name }}
        warmup={query.data.warmup}
        onChanged={refetch}
      />

      <div className="ms-card" style={{ padding: 0 }}>
        <CardHead inset title={t("audit.title")} subtitle={t("audit.subtitle")} />
        <Table>
          <thead>
            <tr>
              <th>{auditT("columns.when")}</th>
              <th>{auditT("columns.actor")}</th>
              <th>{auditT("columns.action")}</th>
              <th>{auditT("columns.target")}</th>
            </tr>
          </thead>
          <tbody>
            {audit.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: "var(--ms-muted)" }}>
                  {t("audit.none")}
                </td>
              </tr>
            ) : (
              audit.map((row) => (
                <tr key={row.id}>
                  <td style={{ color: "var(--ms-muted)" }}>
                    <RelativeTime date={row.createdAt} />
                  </td>
                  <td>
                    {row.actor.kind === "user"
                      ? (row.actorName ?? (
                          <span className="ms-mono">{row.actor.id.slice(0, 8)}</span>
                        ))
                      : auditT(`actors.${row.actor.kind}`)}
                  </td>
                  <td>
                    {(AUDIT_ACTIONS as readonly string[]).includes(row.action) ? (
                      settings(`audit.actions.${row.action.replace(".", "_")}`)
                    ) : (
                      <span className="ms-chip">{row.action}</span>
                    )}
                  </td>
                  <td className="ms-mono" style={{ color: "var(--ms-muted)" }}>
                    {row.target ?? common("none")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>

      <Modal
        open={flagDialog}
        onClose={closeFlagDialog}
        onConfirm={submitFlag}
        title={t("openFlagTitle", { team: team.name })}
      >
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("openFlagLead")}
        </p>
        <div className="ms-field">
          <label htmlFor="safety-flag-note">{common("note")}</label>
          <textarea
            id="safety-flag-note"
            className="ms-input"
            style={{ width: "100%", minHeight: 80, resize: "vertical" }}
            maxLength={1000}
            placeholder={common("noteHint")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={closeFlagDialog}>
            {common("cancel")}
            <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={!note.trim() || open.isPending}
            onClick={submitFlag}
          >
            <BtnSpinner on={open.isPending} />
            {t("openFlagConfirm")}
            <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>
      {actions.dialogs}
      {reveal.dialogs}
    </>
  );
}

type WarmupOverview = {
  enabled: boolean;
  trustedAt: Date | string | null;
  domains: {
    id: string;
    name: string;
    registeredAt: Date | string | null;
    ageSource: string | null;
    ageCheckedAt: Date | string | null;
    trustedAt: Date | string | null;
    today: { cap: number; used: number; fullAt: Date | string | null } | null;
  }[];
  pool: { cap: number; used: number } | null;
};

/** The team's domains under the new-domain warm-up, and the operator's trust over it. */
function WarmupCard({
  team,
  warmup,
  onChanged,
}: {
  team: { id: string; name: string };
  warmup: WarmupOverview;
  onChanged: () => void;
}) {
  const t = useTranslations("console.safety.review.warmup");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const trpc = useTRPC();
  const trust = useMutation(trpc.console.safety.setWarmupTrust.mutationOptions());
  const set = (trusted: boolean, domain?: { id: string; name: string }) =>
    trust.mutate(
      { teamId: team.id, trusted, ...(domain ? { domainId: domain.id } : {}) },
      {
        onSuccess: () => {
          toast(
            t(trusted ? "toast.trusted" : "toast.untrusted", { name: domain?.name ?? team.name }),
          );
          onChanged();
        },
      },
    );
  const teamTrusted = warmup.trustedAt !== null;
  return (
    <div className="ms-card" style={{ padding: 0, marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
          padding: "20px 20px 0",
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <CardHead
            title={t("title")}
            subtitle={
              !warmup.enabled
                ? t("off")
                : teamTrusted
                  ? t("teamTrusted", { date: formatDayTime(warmup.trustedAt ?? 0, locale) })
                  : t("subtitle")
            }
          />
        </div>
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={trust.isPending}
          onClick={() => set(!teamTrusted)}
        >
          <BtnSpinner on={trust.isPending} />
          {t(teamTrusted ? "untrustTeam" : "trustTeam")}
        </button>
      </div>
      {warmup.pool ? (
        <div style={{ padding: "8px 20px 0", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("pool", { used: nf.format(warmup.pool.used), cap: nf.format(warmup.pool.cap) })}
        </div>
      ) : null}
      <Table>
        <thead>
          <tr>
            <th>{t("cols.domain")}</th>
            <th>{t("cols.registered")}</th>
            <th>{t("cols.today")}</th>
            <th className="right">{t("cols.trust")}</th>
          </tr>
        </thead>
        <tbody>
          {warmup.domains.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ color: "var(--ms-muted)" }}>
                {common("none")}
              </td>
            </tr>
          ) : (
            warmup.domains.map((domain) => (
              <tr key={domain.id}>
                <td className="ms-mono">{domain.name}</td>
                <td style={{ color: "var(--ms-muted)" }}>
                  {domain.registeredAt
                    ? t("registered", {
                        date: formatDay(domain.registeredAt, locale),
                        source: t(`sources.${domain.ageSource ?? "unknown"}`),
                      })
                    : t(domain.ageCheckedAt ? "unknownAge" : "notChecked")}
                </td>
                <td>
                  {domain.trustedAt
                    ? t("trusted")
                    : domain.today
                      ? t(domain.today.fullAt ? "today" : "todayNoDate", {
                          used: nf.format(domain.today.used),
                          cap: nf.format(domain.today.cap),
                          date: domain.today.fullAt ? formatDay(domain.today.fullAt, locale) : "",
                        })
                      : t("full")}
                </td>
                <td className="right">
                  <button
                    type="button"
                    className="ms-link"
                    style={{
                      font: "inherit",
                      padding: 0,
                      background: "none",
                      border: 0,
                      cursor: "pointer",
                    }}
                    disabled={trust.isPending}
                    onClick={() => set(!domain.trustedAt, domain)}
                  >
                    {t(domain.trustedAt ? "untrustDomain" : "trustDomain")}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </Table>
    </div>
  );
}

/** Reason codes, each explained on hover; a code this build has no text for stays plain. */
function ReasonCodes({ codes }: { codes: string[] }) {
  const monitorT = useTranslations("console.safety.review.monitor");
  return codes.map((code, i) => (
    <span key={code}>
      {i > 0 ? ", " : null}
      {monitorT.has(`reasonCodes.${code}`) ? (
        <Tooltip inline text={monitorT(`reasonCodes.${code}`)} triggerClassName="ms-reason-code">
          {code}
        </Tooltip>
      ) : (
        code
      )}
    </span>
  ));
}

/** The header's primary action; the tooltip exists only when there is a reason to give. */
function RequestAccessButton({
  on,
  disabled,
  label,
  off,
  onClick,
}: {
  on: boolean;
  disabled: boolean;
  label: string;
  off: string;
  onClick: () => void;
}) {
  const button = (
    <button type="button" className="ms-btn ms-btn-primary" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
  return on ? (
    button
  ) : (
    <Tooltip inline text={off}>
      {button}
    </Tooltip>
  );
}

function Tile({
  label,
  color,
  children,
}: {
  label: React.ReactNode;
  color?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="ms-card" style={TILE}>
      <div className="ms-microlabel">{label}</div>
      <div className="ms-digits" style={{ fontSize: 26, marginTop: 2, color }}>
        {children}
      </div>
    </div>
  );
}

/** Mirrors the loaded page: header, five tiles, two cards, two tables. */
function ReviewSkeleton() {
  return (
    <>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", marginBottom: 10 }}>
          <Skeleton width={160} height={13} />
        </div>
        <div style={{ display: "flex" }}>
          <Skeleton width={260} height={30} />
        </div>
        <div style={{ display: "flex", marginTop: 8 }}>
          <Skeleton width={380} />
        </div>
      </div>
      <div className="ms-grid ms-grid-tiles" style={{ marginBottom: 16 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="ms-card" style={TILE}>
            <div className="ms-microlabel" style={{ display: "flex" }}>
              <Skeleton width={80} height="1lh" />
            </div>
            <div className="ms-digits" style={{ fontSize: 26, marginTop: 2, display: "flex" }}>
              <Skeleton width={70} height="1lh" />
            </div>
          </div>
        ))}
      </div>
      <div className="ms-grid ms-grid-12" style={{ marginBottom: 16 }}>
        {[0, 1].map((i) => (
          <div key={i} className="ms-card" style={{ padding: 20 }}>
            <div style={{ display: "flex", marginBottom: 16 }}>
              <Skeleton width={120} height={22} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Skeleton width="70%" />
              <Skeleton width="50%" />
              <Skeleton width="60%" />
            </div>
          </div>
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="ms-card" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", marginBottom: 16 }}>
            <Skeleton width={160} height={22} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Skeleton width="80%" />
            <Skeleton width="65%" />
            <Skeleton width="72%" />
          </div>
        </div>
      ))}
    </>
  );
}
