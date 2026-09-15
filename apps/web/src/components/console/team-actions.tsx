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

/** The facts every team action needs, as both the Teams list and the Trust & safety rows carry them. */
export interface TeamActionTarget {
  id: string;
  name: string;
  plan: string;
  planQuota: number | null;
  suspendedAt: Date | null;
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
  /** Render once per page: the dialogs the actions above open. */
  dialogs: React.ReactNode;
}

type DialogKind = "team" | "limits" | "plan" | "pause" | "suspend" | "reinstate";

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

  const done = (message: string, teamId: string) => {
    toast(message);
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

  const team = dialog?.team;
  const loaded = detail.data?.id === team?.id ? detail.data : undefined;

  const dialogs = team ? (
    <>
      {dialog?.kind === "team" ? (
        <TeamDialog
          name={team.name}
          detail={loaded}
          onClose={close}
          onAdjustLimits={() => setDialog({ kind: "limits", team })}
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
                    t(input.notify ? "toast.pausedNotified" : "toast.paused", { team: team.name }),
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
          pending={suspend.isPending}
          onClose={close}
          onSubmit={(input) =>
            suspend.mutate(
              { id: team.id, ...input },
              {
                onSuccess: () =>
                  done(
                    t("toast.suspended", {
                      team: team.name,
                      reason: t(`suspendDialog.reasons.${input.reason}`),
                    }),
                    team.id,
                  ),
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
              { onSuccess: () => done(t("toast.reinstated", { team: team.name }), team.id) },
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
 * team, Adjust limits, Change plan, separator, Pause/Resume broadcasts,
 * Suspend/Reinstate team. `labels` come from console.teams.menu.
 */
export function teamMenuItems(
  team: TeamActionTarget,
  actions: TeamActions,
  labels: (key: string) => string,
): (PopoverMenuItem | null)[] {
  return [
    { label: labels("open"), onSelect: () => actions.openTeam(team) },
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
