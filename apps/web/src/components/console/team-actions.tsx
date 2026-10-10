"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { PopoverMenuItem } from "@/components/popover-menu";
import { toast } from "@/components/toast";
import { planLabel } from "@/lib/console-format";
import { useTRPC } from "@/lib/trpc";
import { usePlanName } from "./teams/cells";
import { PauseDialog, ReinstateDialog, SuspendDialog } from "./teams/hold-dialogs";
import { LimitsDialog } from "./teams/limits-dialog";
import { PlanDialog } from "./teams/plan-dialog";
import { TeamDialog } from "./teams/team-dialog";
import { ViewDialog } from "./teams/view-dialog";

/** The facts every team action needs, as both the Teams list and the Trust & safety rows carry them. */
export interface TeamActionTarget {
  id: string;
  name: string;
  plan: string;
  planQuota: number | null;
  suspendedAt: Date | null;
  /** A review hold opens Suspend on phishing, the conversion it usually ends in. */
  suspensionReason?: string | null;
  broadcastsPausedByOperatorAt: Date | null;
}

export interface TeamActions {
  /** The team dialog (counters, type, owner, members, region, guardrail, created, Stripe). */
  openTeam(team: TeamActionTarget): void;
  adjustLimits(team: TeamActionTarget): void;
  changePlan(team: TeamActionTarget): void;
  pauseBroadcasts(team: TeamActionTarget): void;
  resumeBroadcasts(team: TeamActionTarget): void;
  suspend(team: TeamActionTarget): void;
  reinstate(team: TeamActionTarget): void;
  /** The read-only support view of the team's dashboard (SUPPORT_VIEW=on). */
  viewAsOwner(team: TeamActionTarget): void;
  /** Render once per page: the dialogs the actions above open. */
  dialogs: React.ReactNode;
}

type DialogKind = "team" | "limits" | "plan" | "pause" | "suspend" | "reinstate" | "view";

/**
 * Every operator action on a team and its dialog (Adjust limits, Change
 * plan, Pause broadcasts, Suspend, Reinstate, and the team detail dialog),
 * behind one hook so the Teams list and the Trust & safety screens share
 * them. `onChanged` re-fetches the caller's data after a mutation;
 * successes toast, failures toast in danger.
 */
export function useTeamActions(onChanged: () => void): TeamActions {
  const t = useTranslations("console.teams");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const planName = usePlanName();
  const [dialog, setDialog] = useState<{ kind: DialogKind; team: TeamActionTarget } | null>(null);
  const close = useCallback(() => setDialog(null), []);
  const open = (kind: DialogKind) => (team: TeamActionTarget) => setDialog({ kind, team });

  // The detail feeds the team, limits and plan dialogs; one query, one cache entry.
  const needsDetail =
    dialog?.kind === "team" || dialog?.kind === "limits" || dialog?.kind === "plan";
  const detail = useQuery(
    trpc.console.teams.detail.queryOptions({ id: dialog?.team.id ?? "" }, { enabled: needsDetail }),
  );

  const done = (message: string, teamId: string, tone?: "warn") => {
    toast(message, tone);
    setDialog(null);
    void queryClient.invalidateQueries({
      queryKey: trpc.console.teams.detail.queryKey({ id: teamId }),
    });
    onChanged();
  };
  const failed = (error: { message: string }) => {
    toast(t("toast.error", { message: error.message }), "danger");
  };
  const detailError = detail.error;
  useEffect(() => {
    if (!detailError) return;
    toast(t("toast.error", { message: detailError.message }), "danger");
    setDialog(null);
  }, [detailError, t]);

  const limits = useMutation(trpc.console.teams.adjustLimits.mutationOptions({ onError: failed }));
  const plan = useMutation(trpc.console.teams.changePlan.mutationOptions({ onError: failed }));
  const pause = useMutation(
    trpc.console.teams.pauseBroadcasts.mutationOptions({ onError: failed }),
  );
  const resume = useMutation(
    trpc.console.teams.resumeBroadcasts.mutationOptions({ onError: failed }),
  );
  const suspend = useMutation(trpc.console.teams.suspend.mutationOptions({ onError: failed }));
  const reinstate = useMutation(trpc.console.teams.reinstate.mutationOptions({ onError: failed }));
  // Asked each time the dialog opens: a code this session confirmed may
  // have lapsed since, or been confirmed in another tab.
  const verified = useQuery(
    trpc.console.teams.supportViewVerified.queryOptions(undefined, {
      enabled: dialog?.kind === "view",
      staleTime: 0,
    }),
  );
  // A refusal stays in the dialog (the code is one it can explain) and asks
  // again after the confirmed code: a start that failed after its code
  // checked out needs no second one, and a lapsed mark must stop offering a
  // start without one. Success leaves for the dashboard in this tab, so the
  // layout reads the new cookie.
  const view = useMutation(
    trpc.console.teams.startSupportView.mutationOptions({
      onSuccess: () => window.location.assign("/"),
      onError: () => void verified.refetch(),
    }),
  );
  const viewCode = useMutation(trpc.console.teams.sendSupportViewCode.mutationOptions());
  const openView = (target: TeamActionTarget) => {
    view.reset();
    viewCode.reset();
    setDialog({ kind: "view", team: target });
  };

  const team = dialog?.team;
  const loaded = detail.data?.id === team?.id ? detail.data : undefined;

  const dialogs = team ? (
    <>
      {dialog?.kind === "team" ? (
        <TeamDialog
          id={team.id}
          name={team.name}
          detail={loaded}
          onClose={close}
          onAdjustLimits={() => setDialog({ kind: "limits", team })}
          onViewAsOwner={() => openView(team)}
        />
      ) : null}
      {dialog?.kind === "view" ? (
        <ViewDialog
          name={team.name}
          pending={view.isPending || view.isSuccess || viewCode.isPending}
          error={(view.error ?? viewCode.error)?.message ?? null}
          step={viewCode.data ?? null}
          verifiedUntil={verified.data?.until ?? null}
          onClose={close}
          onSendCode={() => {
            view.reset();
            viewCode.mutate();
          }}
          onSubmit={(input) => view.mutate({ id: team.id, ...input })}
        />
      ) : null}
      {dialog?.kind === "limits" ? (
        <LimitsDialog
          name={team.name}
          detail={loaded}
          pending={limits.isPending}
          onClose={close}
          onSubmit={(input) =>
            limits.mutate(
              { id: team.id, ...input },
              { onSuccess: () => done(t("toast.limits", { team: team.name }), team.id) },
            )
          }
        />
      ) : null}
      {dialog?.kind === "plan" ? (
        <PlanDialog
          name={team.name}
          detail={loaded}
          pending={plan.isPending}
          onClose={close}
          onSubmit={(rung, label) =>
            plan.mutate(
              { id: team.id, plan: rung.plan, planQuota: rung.planQuota },
              {
                onSuccess: () =>
                  done(
                    t("toast.plan", {
                      team: team.name,
                      from: planLabel(planName(team.plan), team.planQuota),
                      to: label,
                    }),
                    team.id,
                  ),
              },
            )
          }
        />
      ) : null}
      {dialog?.kind === "pause" ? (
        <PauseDialog
          name={team.name}
          pending={pause.isPending}
          onClose={close}
          onSubmit={(input) =>
            pause.mutate(
              { id: team.id, ...input },
              {
                onSuccess: () =>
                  done(
                    t(input.notify && !team.suspendedAt ? "toast.pausedNotified" : "toast.paused", {
                      team: team.name,
                    }),
                    team.id,
                  ),
              },
            )
          }
        />
      ) : null}
      {dialog?.kind === "suspend" ? (
        <SuspendDialog
          name={team.name}
          initialReason={team.suspensionReason === "review" ? "phishing" : undefined}
          pending={suspend.isPending}
          onClose={close}
          onSubmit={(input) =>
            suspend.mutate(
              { id: team.id, ...input },
              {
                onSuccess: ({ tenant }) => {
                  const regions = tenant?.failed.map((f) => f.region).join(", ");
                  done(
                    regions
                      ? t("toast.suspendedTenantFailed", { team: team.name, regions })
                      : t("toast.suspended", {
                          team: team.name,
                          reason: t(`suspendDialog.reasons.${input.reason}`),
                        }),
                    team.id,
                    regions ? "warn" : undefined,
                  );
                },
              },
            )
          }
        />
      ) : null}
      {dialog?.kind === "reinstate" ? (
        <ReinstateDialog
          name={team.name}
          pending={reinstate.isPending}
          onClose={close}
          onSubmit={() =>
            reinstate.mutate(
              { id: team.id },
              {
                onSuccess: ({ tenant }) => {
                  const regions = tenant?.failed.map((f) => f.region).join(", ");
                  done(
                    regions
                      ? t("toast.reinstatedTenantFailed", { team: team.name, regions })
                      : t("toast.reinstated", { team: team.name }),
                    team.id,
                    regions ? "warn" : undefined,
                  );
                },
              },
            )
          }
        />
      ) : null}
    </>
  ) : null;

  return {
    openTeam: open("team"),
    adjustLimits: open("limits"),
    changePlan: open("plan"),
    pauseBroadcasts: open("pause"),
    suspend: open("suspend"),
    reinstate: open("reinstate"),
    viewAsOwner: openView,
    resumeBroadcasts: (target) =>
      resume.mutate(
        { id: target.id },
        { onSuccess: () => done(t("toast.resumed", { team: target.name }), target.id) },
      ),
    dialogs,
  };
}

/**
 * The Teams list's "…" items for one team, from the shared actions: Open
 * team, Copy ID (when `copyId` is given), View as owner (when `options` are
 * given: disabled with the reason while the feature is off or the team is
 * silently suspended), Adjust limits, Change plan, separator, Pause/Resume
 * broadcasts, Suspend/Reinstate team. `labels` come from console.teams.menu.
 */
export function teamMenuItems(
  team: TeamActionTarget,
  actions: TeamActions,
  labels: (key: string) => string,
  options?: { supportView: boolean; silentlySuspended: boolean; copyId?: (id: string) => void },
): (PopoverMenuItem | null)[] {
  const copyId = options?.copyId;
  const viewOff = !options?.supportView
    ? "viewOff"
    : options.silentlySuspended
      ? "viewSilent"
      : null;
  return [
    { label: labels("open"), onSelect: () => actions.openTeam(team) },
    ...(copyId ? [{ label: labels("copyId"), onSelect: () => copyId(team.id) }] : []),
    options
      ? {
          label: labels("view"),
          onSelect: () => actions.viewAsOwner(team),
          disabled: viewOff !== null,
          ...(viewOff ? { title: labels(viewOff) } : {}),
        }
      : null,
    { label: labels("limits"), onSelect: () => actions.adjustLimits(team) },
    { label: labels("plan"), onSelect: () => actions.changePlan(team) },
    null,
    team.broadcastsPausedByOperatorAt
      ? { label: labels("resume"), onSelect: () => actions.resumeBroadcasts(team) }
      : { label: labels("pause"), onSelect: () => actions.pauseBroadcasts(team) },
    team.suspendedAt
      ? { label: labels("reinstate"), onSelect: () => actions.reinstate(team) }
      : { label: labels("suspend"), danger: true, onSelect: () => actions.suspend(team) },
  ];
}
