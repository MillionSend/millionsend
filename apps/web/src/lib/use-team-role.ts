import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useTRPC } from "@/lib/trpc";

const noSubscription = () => () => {};

/**
 * The signed-in user's role in the active team; undefined until the team list
 * loads, and while the page hydrates: the server renders without the list, but
 * the layout may already hold it in the client cache by then, and a control
 * gated on the role would make the hydrating render differ from the server's.
 */
export function useTeamRole(): "owner" | "admin" | "member" | undefined {
  const trpc = useTRPC();
  const teamList = useQuery(trpc.team.list.queryOptions());
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!hydrated) return undefined;
  return teamList.data?.teams.find((m) => m.teamId === teamList.data?.activeTeamId)?.role;
}
