"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isReadOnly } from "@/lib/read-only";
import { useTRPC } from "@/lib/trpc";

/**
 * How often inbox data refreshes on its own while the page is open: an open
 * folder's list and the sidebar's unread count.
 */
export const INBOX_POLL_MS = 60_000;

/**
 * Unread threads across the team's People inboxes, for the sidebar's count
 * and the phone menu's dot: 0 until it loads, and where the instance takes no
 * mail. Never polled under a support view, which counts every read on its grant.
 */
export function useInboxUnread(receiving: boolean): number {
  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.inboxes.unread.queryOptions(undefined, {
      enabled: receiving,
      refetchInterval: () => (isReadOnly() ? false : INBOX_POLL_MS),
    }),
  );
  return receiving ? (data ?? 0) : 0;
}

/**
 * Refetches the count at once. The sidebar stays mounted across pages, so a
 * change made elsewhere (a read, a release, a deleted inbox or domain) shows
 * there only when told, or on the next poll.
 */
export function useRefreshInboxUnread(): () => void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.unread.queryKey() });
  };
}
