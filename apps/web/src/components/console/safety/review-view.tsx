"use client";

import { AUDIT_ACTIONS } from "@millionsend/core/audit-actions";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { type DomainRegion, regionFlag } from "@/app/(dashboard)/domains/regions";
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
import { formatRelative } from "@/lib/format";
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

const TILE: React.CSSProperties = { padding: "18px 22px" };
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

  const [flagDialog, setFlagDialog] = useState(false);
  const [note, setNote] = useState("");
  const closeFlagDialog = useCallback(() => {
    setFlagDialog(false);
    setNote("");
  }, []);

  if (query.isError) return <LoadErrorCard onRetry={refetch} />;
  if (query.isPending) return <ReviewSkeleton />;

  const { team, flag, standing, checks, flaggedEmails, audit } = query.data;
  const target = {
    id: team.id,
    name: team.name,
    plan: team.plan,
    planQuota: team.planQuota,
    suspendedAt: team.suspendedAt,
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
  const subtitle =
    flag?.status === "open"
      ? t("proof", { ...proofValues, since: formatRelative(flag.openedAt, locale) })
      : t("proofNoFlag", proofValues);
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

  const standingBadge = team.suspendedAt
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
            ) : null}
            <PopoverMenu
              boxed
              ariaLabel={common("actions")}
              items={[
                team.suspendedAt
                  ? { label: safety("menu.reinstate"), onSelect: () => actions.reinstate(target) }
                  : {
                      label: safety("menu.suspend"),
                      danger: true,
                      onSelect: () => actions.suspend(target),
                    },
                ...(flagOpen
                  ? []
                  : [{ label: t("openFlag"), onSelect: () => setFlagDialog(true) }]),
              ]}
            />
          </>
        }
      />

      <div
        className="ms-grid"
        style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", marginBottom: 16 }}
      >
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

      <div className="ms-grid ms-grid-12" style={{ marginBottom: 16 }}>
        <div className="ms-card" style={{ padding: 24 }}>
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
        <div className="ms-card" style={{ padding: 24 }}>
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
            </tr>
          </thead>
          <tbody>
            {flaggedEmails.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: "var(--ms-muted)" }}>
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
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>

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
    </>
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
      <div
        className="ms-grid"
        style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", marginBottom: 16 }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
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
          <div key={i} className="ms-card" style={{ padding: 24 }}>
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
        <div key={i} className="ms-card" style={{ padding: 24, marginBottom: 16 }}>
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
