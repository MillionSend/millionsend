"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { RelativeTime } from "@/components/relative-time";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { TeamLogo } from "@/components/team-logo";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { useTRPC } from "@/lib/trpc";
import { useTeamActions } from "../team-actions";
import { CardHead } from "./parts";

const COLUMNS = 6;
// What makes each email wait: a hold or a verdict the operator decides on,
// or a judge or reader that could not answer.
const WHY_DOT: Record<string, string> = {
  held: "var(--ms-warn)",
  verdict: "var(--ms-warn)",
  destination: "var(--ms-warn)",
  outage: "var(--ms-danger)",
  media: "var(--ms-danger)",
};
const LINK_BUTTON: React.CSSProperties = {
  font: "inherit",
  padding: 0,
  background: "none",
  border: 0,
  cursor: "pointer",
};

type Cancel = { teamId: string; team: string; emailIds?: string[]; count: number };

/**
 * The review list: unsent emails screening stopped before SES, grouped by
 * team, released (sent without being screened again) or canceled (never
 * sent) one by one or per team. A team held for review is released with its
 * hold. Renders nothing while no email waits.
 */
export function WaitingList({ teamId, onChanged }: { teamId?: string; onChanged?: () => void }) {
  const t = useTranslations("console.safety.waiting");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const trpc = useTRPC();
  const query = useQuery(trpc.console.safety.waiting.queryOptions(teamId ? { teamId } : {}));
  const refetch = () => {
    void query.refetch();
    onChanged?.();
  };
  const actions = useTeamActions(refetch);
  const release = useMutation(trpc.console.safety.releaseWaiting.mutationOptions());
  const cancel = useMutation(trpc.console.safety.cancelWaiting.mutationOptions());
  const [confirm, setConfirm] = useState<Cancel | null>(null);
  const failed = (error: { message: string }) =>
    toast(t("toast.error", { message: error.message }), "danger");

  const groups = query.data?.groups ?? [];
  if (groups.length === 0) return actions.dialogs;
  const total = groups.reduce((n, group) => n + group.total, 0);
  const busy = release.isPending || cancel.isPending;

  const doRelease = (group: (typeof groups)[number], emailIds?: string[]) =>
    release.mutate(
      { teamId: group.team.id, ...(emailIds ? { emailIds } : {}) },
      {
        onSuccess: ({ released }) => {
          toast(t("toast.released", { team: group.team.name, count: released }));
          refetch();
        },
        onError: failed,
      },
    );
  const doCancel = () => {
    if (!confirm || cancel.isPending) return;
    cancel.mutate(
      { teamId: confirm.teamId, ...(confirm.emailIds ? { emailIds: confirm.emailIds } : {}) },
      {
        onSuccess: ({ canceled }) => {
          toast(t("toast.canceled", { team: confirm.team, count: canceled }));
          setConfirm(null);
          refetch();
        },
        onError: failed,
      },
    );
  };

  return (
    <>
      <div className="ms-card" style={{ padding: 0, marginBottom: 16 }}>
        <CardHead inset title={t("title", { count: total })} subtitle={t("subtitle")} />
        <Table className="nowrap">
          <thead>
            <tr>
              <th>{t("cols.since")}</th>
              <th>{t("cols.from")}</th>
              <th>{t("cols.why")}</th>
              <th className="right">{t("cols.score")}</th>
              <th className="right">{t("cols.recipients")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const held = group.team.suspensionReason === "review";
              const suspended = group.team.suspendedAt !== null;
              const target = {
                id: group.team.id,
                name: group.team.name,
                plan: group.team.plan,
                planQuota: group.team.planQuota,
                suspendedAt: group.team.suspendedAt,
                suspensionReason: group.team.suspensionReason,
                broadcastsPausedByOperatorAt: group.team.broadcastsPausedByOperatorAt,
              };
              const releaseTip = held ? t("heldTip") : t("suspendedTip");
              return (
                <Fragment key={group.team.id}>
                  <tr>
                    <td colSpan={COLUMNS - 1} style={{ fontWeight: 500 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <TeamLogo name={group.team.name} logoUrl={group.team.logoUrl} size={22} />
                        {teamId ? (
                          group.team.name
                        ) : (
                          <Link href={`/console/safety/${group.team.id}`}>{group.team.name}</Link>
                        )}
                        <span style={{ color: "var(--ms-muted)", fontWeight: 400 }}>
                          {[
                            t("count", { count: group.total }),
                            ...(held ? [t("heldTeam")] : suspended ? [t("suspendedTeam")] : []),
                          ].join(" · ")}
                        </span>
                      </span>
                    </td>
                    <td className="right">
                      {held ? (
                        <button
                          type="button"
                          className="ms-link"
                          style={LINK_BUTTON}
                          disabled={busy}
                          onClick={() => actions.reinstate(target)}
                        >
                          {t("releaseHold")}
                        </button>
                      ) : suspended ? null : (
                        <button
                          type="button"
                          className="ms-link"
                          style={LINK_BUTTON}
                          disabled={busy}
                          onClick={() => doRelease(group)}
                        >
                          {t("releaseAll")}
                        </button>
                      )}
                      {suspended && !held ? null : " · "}
                      <button
                        type="button"
                        className="ms-link"
                        style={LINK_BUTTON}
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            teamId: group.team.id,
                            team: group.team.name,
                            count: group.total,
                          })
                        }
                      >
                        {t("cancelAll")}
                      </button>
                    </td>
                  </tr>
                  {group.emails.map((email) => (
                    <tr key={email.id}>
                      <td style={{ color: "var(--ms-muted)" }}>
                        <RelativeTime date={email.createdAt} />
                      </td>
                      <td className="ms-mono">{email.from}</td>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span
                            className="ms-dot"
                            style={{ background: WHY_DOT[email.why] ?? "var(--ms-muted)" }}
                          />
                          {t(`why.${email.why}`)}
                          {email.destinations.length > 0 ? (
                            <span className="ms-mono" style={{ color: "var(--ms-muted)" }}>
                              {email.destinations.join(", ")}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="right num">{email.score ?? common("none")}</td>
                      <td className="right num">{nf.format(email.recipients)}</td>
                      <td className="right">
                        {suspended ? (
                          <Tooltip inline text={releaseTip}>
                            <span style={{ color: "var(--ms-muted)" }}>{t("release")}</span>
                          </Tooltip>
                        ) : (
                          <button
                            type="button"
                            className="ms-link"
                            style={LINK_BUTTON}
                            disabled={busy}
                            onClick={() => doRelease(group, [email.id])}
                          >
                            {t("release")}
                          </button>
                        )}
                        {" · "}
                        <button
                          type="button"
                          className="ms-link"
                          style={LINK_BUTTON}
                          disabled={busy}
                          onClick={() =>
                            setConfirm({
                              teamId: group.team.id,
                              team: group.team.name,
                              emailIds: [email.id],
                              count: 1,
                            })
                          }
                        >
                          {t("cancel")}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {group.total > group.emails.length ? (
                    <tr>
                      <td colSpan={COLUMNS} style={{ color: "var(--ms-muted)" }}>
                        {t("more", { count: group.total - group.emails.length })}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </div>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={doCancel}
        title={t("cancelTitle", { count: confirm?.count ?? 1, team: confirm?.team ?? "" })}
      >
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("cancelLead")}
        </p>
        <ModalFooter>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => setConfirm(null)}
          >
            {t("keep")}
            <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={cancel.isPending}
            onClick={doCancel}
          >
            <BtnSpinner on={cancel.isPending} />
            {t("cancelConfirm")}
            <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>
      {actions.dialogs}
    </>
  );
}
