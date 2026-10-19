/**
 * What holds a team's addresses on the shared domain back from starting
 * conversations: its plan, the instance, or sending paused outright; null
 * when nothing does or the inbox is on a team's own domain. No mode reads as
 * replies only, as core's safety rules read it. Its words are
 * inboxes.sharedMode.*.
 */
export function sharedModeKey(inbox: {
  shared: boolean;
  sharedSending?: { mode: string; cause: string | null } | null | undefined;
}): "plan" | "instance" | "paused" | null {
  const s = inbox.sharedSending;
  if (!inbox.shared || s?.mode === "open") return null;
  return s?.mode === "receive_only" ? "paused" : s?.cause === "plan" ? "plan" : "instance";
}
