import type { InboxSafety } from "../inboxes/safety.js";
import type {
  InboxKind,
  QuarantineReason,
  ScreeningVerdict,
  SenderTrust,
  SpamVerdict,
  VirusVerdict,
} from "../inboxes/types.js";

export type ScreeningAction = "deliver" | "spam" | "judge" | "quarantine";

export interface ScreeningDecision {
  action: ScreeningAction;
  reason?: QuarantineReason | undefined;
  verdict: ScreeningVerdict;
}

/**
 * What happens to a received message in one inbox, before any judge: the
 * first rule that matches wins. A virus quarantines everywhere; a people's
 * inbox open to anyone delivers, a failed sender to the spam folder as a
 * mailbox would, never a hold; otherwise the inbox's accept_from and the
 * sender's tier decide. Judging is for agent inboxes with screening on and a
 * judge to ask; spam that fails goes to the spam folder instead of the inbox.
 */
export function decideScreening(i: {
  kind: InboxKind;
  safety: InboxSafety;
  tier: SenderTrust;
  /** From names an owner or an allowlist entry, proven or not; absent reads as not listed. */
  listed?: boolean | undefined;
  spam: SpamVerdict | null;
  virus: VirusVerdict | null;
  judgeAvailable: boolean;
  /** A forward marker or an attached message: forwarded content inherits no trust. */
  forwardedContent: boolean;
}): ScreeningDecision {
  if (i.virus === "fail") return { action: "quarantine", reason: "virus", verdict: "quarantined" };
  const quarantine = (reason: QuarantineReason): ScreeningDecision => ({
    action: "quarantine",
    reason,
    verdict: "quarantined",
  });
  let action: "deliver" | "judge";
  if (i.kind === "human" && i.safety.accept_from === "anyone") {
    action = "deliver";
  } else {
    const accept = i.safety.accept_from;
    switch (i.tier) {
      case "failed":
        return quarantine("failed_auth");
      case "owner":
      case "allowlisted":
        action = i.forwardedContent && i.safety.screening ? "judge" : "deliver";
        break;
      case "known_thread":
        action = "deliver";
        break;
      case "external":
        if (accept === "allowlist") return quarantine("not_allowlisted");
        action = "judge";
        break;
      case "unauthenticated":
        // A listed address counts only once proven: unproven, it is unverified, not a stranger.
        if (accept === "allowlist" && !i.listed) return quarantine("not_allowlisted");
        if (accept !== "anyone") return quarantine("unauthenticated_sender");
        action = "judge";
        break;
    }
    // The judge reads agent inboxes only.
    if (i.kind === "human") action = "deliver";
  }
  if (action === "judge" && (!i.safety.screening || !i.judgeAvailable)) action = "deliver";
  if (action === "judge") return { action: "judge", verdict: "pending" };
  const suspicious =
    i.tier === "unauthenticated" ||
    i.tier === "failed" ||
    i.spam === "gray" ||
    i.spam === "fail" ||
    i.virus === "processing_failed";
  return {
    // Only a people's inbox open to anyone gets here with a failed sender.
    action: i.spam === "fail" || i.tier === "failed" ? "spam" : "deliver",
    verdict: suspicious ? "suspicious" : "clean",
  };
}
