import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";
import { useTRPC } from "@/lib/trpc";
import type { TeamRole } from "@/server/membership";

const noSubscription = () => () => {};

/** The role the server rendered the page with; AppShell provides it. */
export const ServerTeamRole = createContext<TeamRole | undefined>(undefined);

/**
 * The signed-in user's role in the active team; undefined under a support
 * view. While the page hydrates, and until the client's team list loads, it is
 * the server's role, so a role-gated control is already in the server HTML and
 * the hydrating render matches it even when the list is cached by then.
 */
export function useTeamRole(): TeamRole | undefined {
  const serverRole = useContext(ServerTeamRole);
  const trpc = useTRPC();
  const teamList = useQuery(trpc.team.list.queryOptions());
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!hydrated || !teamList.data) return serverRole;
  return teamList.data.teams.find((m) => m.teamId === teamList.data?.activeTeamId)?.role;
}
