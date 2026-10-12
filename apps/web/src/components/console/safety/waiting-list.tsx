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
import { CardHead, WHY_DOT } from "./parts";
import { useContentReveal } from "./reveal";

const COLUMNS = 6;
const LINK_BUTTON: React.CSSProperties = {
  font: "inherit",
  padding: 0,
  background: "none",
  border: 0,
  cursor: "pointer",
};

type Confirm = {
  action: "release" | "cancel";
  teamId: string;
  team: string;
  emailIds?: string[];
  count: number;
};

/**
 * The review list: unsent emails screening stopped before SES, grouped by
 * team, released (sent without being screened again) or canceled (never
 * sent) one by one or per team. A team held for review is released with its
 * hold. An email screening kept a media review of opens it in the media
 * panel, behind the same content grant as its text. Renders nothing while no
 * email waits.
 */
export function WaitingList({ teamId, onChanged }: { teamId?: string; onChanged?: () => void }) {
  const t = useTranslations("console.safety.waiting");
  const mediaT = useTranslations("console.safety.media");
  const revealT = useTranslations("console.safety.reveal");
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
  const reveal = useContentReveal({ onChanged: refetch });
  const release = useMutation(trpc.console.safety.releaseWaiting.mutationOptions());
  const cancel = useMutation(trpc.console.safety.cancelWaiting.mutationOptions());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const failed = (error: { message: string }) =>
    toast(t("toast.error", { message: error.message }), "danger");

  const groups = query.data?.groups ?? [];
  if (groups.length === 0) {
    return (
      <>
        {actions.dialogs}
        {reveal.dialogs}
      </>
    );
  }
  const grants = query.data?.grants ?? [];
  const contentReveal = query.data?.contentReveal ?? false;
  const total = groups.reduce((n, group) => n + group.total, 0);
  const busy = release.isPending || cancel.isPending;
  // "All" means what this list showed: mail parked after it was read stays.
  const asOf = query.data?.asOf ?? new Date(0);
  const pick = (emailIds?: string[]) => (emailIds ? { emailIds } : { parkedBefore: asOf });

  const doRelease = (team: { id: string; name: string }, emailIds?: string[]) =>
    release.mutate(
      { teamId: team.id, ...pick(emailIds) },
      {
        onSuccess: ({ released }) => {
          toast(t("toast.released", { team: team.name, count: released }));
          setConfirm(null);
          refetch();
        },
        onError: failed,
      },
    );
  const openMedia = (
    team: { id: string; name: string },
    email: (typeof groups)[number]["emails"][number],
  ) => {
    const grant = grants.find(
      (g) => g.emailIds.includes(email.id) && g.expiresAt.getTime() > Date.now(),
    );
    if (grant) {
      reveal.media({ id: team.id, name: team.name }, grant.id, email.id);
      return;
    }
    reveal.request({
      team: { id: team.id, name: team.name },
      email: { id: email.id, from: email.from, sentAt: null, recipients: email.recipients },
      flaggedCount: 0,
      flagLabel: t(`why.${email.why}`),
      media: true,
    });
  };
  const doConfirm = () => {
    if (!confirm || busy) return;
    if (confirm.action === "release") {
      doRelease({ id: confirm.teamId, name: confirm.team }, confirm.emailIds);
      return;
    }
    cancel.mutate(
      { teamId: confirm.teamId, ...pick(confirm.emailIds) },
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
                          onClick={() =>
                            setConfirm({
                              action: "release",
                              teamId: group.team.id,
                              team: group.team.name,
                              count: group.total,
                            })
                          }
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
                            action: "cancel",
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
                        {email.media ? (
                          <>
                            {contentReveal ? (
                              <button
                                type="button"
                                className="ms-link"
                                style={LINK_BUTTON}
                                disabled={busy}
                                onClick={() => openMedia(group.team, email)}
                              >
                                {mediaT("row")}
                              </button>
                            ) : (
                              <Tooltip inline text={revealT("off")}>
                                <span style={{ color: "var(--ms-muted)" }}>{mediaT("row")}</span>
                              </Tooltip>
                            )}
                            {" · "}
                          </>
                        ) : null}
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
                            onClick={() => doRelease(group.team, [email.id])}
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
                              action: "cancel",
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
        onConfirm={doConfirm}
        title={t(confirm?.action === "release" ? "releaseTitle" : "cancelTitle", {
          count: confirm?.count ?? 1,
          team: confirm?.team ?? "",
        })}
      >
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t(confirm?.action === "release" ? "releaseLead" : "cancelLead")}
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
          {confirm?.action === "release" ? (
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={busy}
              onClick={doConfirm}
            >
              <BtnSpinner on={release.isPending} />
              {t("releaseConfirm")}
              <ConfirmKeycap />
            </button>
          ) : (
            <button
              type="button"
              className="ms-btn ms-btn-destructive"
              disabled={busy}
              onClick={doConfirm}
            >
              <BtnSpinner on={cancel.isPending} />
              {t("cancelConfirm")}
              <ConfirmKeycap />
            </button>
          )}
        </ModalFooter>
      </Modal>
      {actions.dialogs}
      {reveal.dialogs}
    </>
  );
}
