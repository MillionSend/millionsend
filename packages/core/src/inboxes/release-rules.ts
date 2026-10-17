import type { InboxActor } from "./activity.js";
import type { InboxKind, QuarantineReason, SenderTrust } from "./types.js";

/**
 * Who may release held mail, and what a release asks first. Imports types
 * only, so the dashboard's release dialog reads the same lists the server
 * enforces.
 */

/**
 * Holds for what a message says, or for a From that failed authentication:
 * a person reads the message before releasing it, and an agent never
 * releases one, since the mail is aimed at the agent.
 */
export const CONTENT_HOLDS: readonly QuarantineReason[] = [
  "injection",
  "phishing",
  "virus",
  "failed_auth",
];

/** Holds made before the judge read the message: releasing one asks the judge first. */
export const SCREENED_ON_RELEASE: readonly QuarantineReason[] = [
  "not_allowlisted",
  "unauthenticated_sender",
  "failed_auth",
];

/** Holds for what the judge or the virus scan found in the message: a release never screens one again. */
export const JUDGED_HOLDS: readonly QuarantineReason[] = ["injection", "phishing", "virus"];

/** The risk behind a hold: the score of what the judge found; other holds have none. */
export function holdRisk(hold: {
  reason: string | null;
  injectionScore: number | null;
  phishingScore: number | null;
}): number | null {
  if (hold.reason === "injection") return hold.injectionScore;
  return hold.reason === "phishing" ? hold.phishingScore : null;
}

/**
 * Whether the actor may release a hold, and may also trust its sender. A
 * person or a team-wide key releases any hold; an agent (MCP) only what
 * isn't a content hold. Trust allowlists the From address, and the
 * allowlist admits only mail that passes authentication: it is offered for
 * a not_allowlisted hold from an authenticated (external) sender, the one
 * case it would let in, and only to those who may edit the allowlist
 * itself, owners and admins or a team-wide key. Agents never trust.
 */
export function releaseRights(p: {
  reason: QuarantineReason;
  senderTrust: SenderTrust;
  actor: InboxActor;
  /** The person releasing is an owner or admin; read for a person only. */
  admin?: boolean | undefined;
}): { release: boolean; trust: boolean } {
  const person = p.actor.kind === "user";
  const teamKey = p.actor.kind === "api_key" && p.actor.inboxId === null;
  const release =
    person || teamKey || (p.actor.kind === "oauth" && !CONTENT_HOLDS.includes(p.reason));
  const trustable = p.reason === "not_allowlisted" && p.senderTrust === "external";
  return { release, trust: release && trustable && ((person && p.admin === true) || teamKey) };
}

/** Whether releasing a hold asks the judge first: agent inboxes that screen, holds from before screening. */
export function screensOnRelease(p: {
  reason: QuarantineReason;
  kind: InboxKind;
  screening: boolean;
}): boolean {
  return p.kind === "agent" && p.screening && SCREENED_ON_RELEASE.includes(p.reason);
}
