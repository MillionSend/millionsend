import { isPlainName } from "../customer-text.js";
import type { InboxActor, ParsedInboxActor } from "./activity.js";
import { FROM_NAME_MAX } from "./username.js";

/** Mirrors the inbox_reply_from_name pgEnum; reply-from.ts checks the two agree. */
export const REPLY_FROM_NAMES = ["inbox", "teammate_inbox", "teammate"] as const;
export type ReplyFromName = (typeof REPLY_FROM_NAMES)[number];

/** Whether a display name may go in a From: plain, short, and nothing that reads as header structure. */
export function isFromName(name: string): boolean {
  return name !== "" && isPlainName(name, FROM_NAME_MAX) && !/[:<>]/.test(name);
}

type ReplyInbox = {
  fromName: string | null;
  domainId: string | null;
  replyFromName: ReplyFromName;
};

/**
 * The display name each mode gives a send by `userName` from an inbox named
 * `fromName`, or null for an account name a From couldn't carry.
 */
export function teammateNames(
  fromName: string | null,
  userName: string | null | undefined,
): { inbox: string | null; teammate_inbox: string; teammate: string } | null {
  const name = userName?.trim() ?? "";
  if (!isFromName(name)) return null;
  const both = fromName ? `${name} (${fromName})` : name;
  return {
    inbox: fromName,
    teammate_inbox: isFromName(both) ? both : name,
    teammate: name,
  };
}

/**
 * Only the inbox's from_name may name a send on the shared domain: the brand
 * guards review stored names only, and a shared From must carry the exact from_name.
 */
function namesFor(inbox: ReplyInbox, userName: string | null | undefined) {
  return inbox.domainId === null ? null : teammateNames(inbox.fromName, userName);
}

/**
 * The From display name of a send from the inbox. A dashboard person's
 * send follows `mode`, else the inbox's reply_from_name; every other actor
 * (API keys, agents, the system's forwards) sends as the inbox.
 */
export function replyFromName(p: {
  inbox: ReplyInbox;
  actor: Pick<InboxActor | ParsedInboxActor, "kind">;
  userName: string | null | undefined;
  mode?: ReplyFromName | null | undefined;
}): string | null {
  const names = p.actor.kind === "user" ? namesFor(p.inbox, p.userName) : null;
  return names ? names[p.mode ?? p.inbox.replyFromName] : p.inbox.fromName;
}

/**
 * What a person may pick for one send, each mode once per distinct name
 * (the default's entry kept), with the account name the teammate modes
 * use, or null when every mode sends as the inbox.
 */
export function replyFromChoices(
  inbox: ReplyInbox,
  userName: string | null | undefined,
): {
  default: ReplyFromName;
  teammate: string;
  options: { value: ReplyFromName; name: string | null }[];
} | null {
  const names = namesFor(inbox, userName);
  if (!names) return null;
  const byName = new Map<string | null, ReplyFromName>();
  for (const mode of [inbox.replyFromName, ...REPLY_FROM_NAMES]) {
    if (!byName.has(names[mode])) byName.set(names[mode], mode);
  }
  const kept = new Set(byName.values());
  return {
    default: inbox.replyFromName,
    teammate: names.teammate,
    options: REPLY_FROM_NAMES.filter((mode) => kept.has(mode)).map((mode) => ({
      value: mode,
      name: names[mode],
    })),
  };
}
