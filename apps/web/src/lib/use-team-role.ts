import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

/** The signed-in user's role in the active team; undefined until the team list loads. */
export function useTeamRole(): "owner" | "admin" | "member" | undefined {
  const trpc = useTRPC();
  const teamList = useQuery(trpc.team.list.queryOptions());
  return teamList.data?.teams.find((m) => m.teamId === teamList.data?.activeTeamId)?.role;
}
