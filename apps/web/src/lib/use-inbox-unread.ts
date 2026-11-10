"use client";

import { useQuery } from "@tanstack/react-query";
import { isReadOnly } from "@/lib/read-only";
import { useTRPC } from "@/lib/trpc";

/** How often an inbox screen looks for new mail on its own while it is on screen. */
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
