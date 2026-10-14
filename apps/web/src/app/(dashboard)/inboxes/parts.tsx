"use client";

import type { InboxSafety } from "@millionsend/db/schema";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import type { BadgeTone } from "@/components/status-badge";
import { Tooltip } from "@/components/tooltip";
import { addrSpec } from "@/lib/format";
import type { AppRouter } from "@/server/routers";

type Outputs = inferRouterOutputs<AppRouter>["inboxes"];
/** The inbox as its page reads it: the wire Inbox plus the dashboard's own facts. */
export type InboxDetail = Outputs["get"];
export type ThreadRow = Outputs["threads"]["list"]["items"][number];
export type ThreadMessage = Outputs["threads"]["emails"]["items"][number];

export type SenderTrust =
  | "owner"
  | "allowlisted"
  | "known_thread"
  | "external"
  | "unauthenticated"
  | "failed";

const TRUST_TONE: Record<SenderTrust, BadgeTone> = {
  owner: "success",
  allowlisted: "success",
  known_thread: "success",
  external: "neutral",
  unauthenticated: "warn",
  failed: "danger",
};

/** Who a sender is to the inbox, in words; the tone follows how far it is trusted. */
export function TrustBadge({ trust }: { trust: SenderTrust }) {
  const t = useTranslations("inboxes");
  return <span className={`ms-badge ms-badge-${TRUST_TONE[trust]}`}>{t(`trust.${trust}`)}</span>;
}

/** "Quarantined · prompt injection": why a message is held. */
export function QuarantinedBadge({ reason }: { reason: string | null }) {
  const t = useTranslations("inboxes");
  return (
    <span className="ms-badge ms-badge-danger">
      {t("badge.quarantined", { reason: reason && t.has(`qr.${reason}`) ? t(`qr.${reason}`) : "" })}
    </span>
  );
}

/** "Suspicious": delivered to the agent with a warning; the screening's scores are in its tooltip. */
export function SuspiciousBadge({
  injection,
  phishing,
}: {
  injection: number | null;
  phishing: number | null;
}) {
  const t = useTranslations("inboxes");
  const scores =
    injection === null && phishing === null
      ? []
      : [t("riskScores", { injection: injection ?? "–", phishing: phishing ?? "–" })];
  return (
    <Tooltip inline text={[t("suspiciousTip"), ...scores].join("\n")}>
      <span className="ms-badge ms-badge-warn">{t("received.verdict.suspicious")}</span>
    </Tooltip>
  );
}

/**
 * Why a send waits for a person, in words. A reason may carry its detail
 * after a colon (loop_guard:auto_submitted); an unknown one shows its key.
 */
export function approvalReasonWords(
  t: ReturnType<typeof useTranslations>,
  reasons: string[],
): string {
  return reasons
    .map((reason) => {
      const key = reason.split(":")[0] ?? reason;
      if (t.has(`reason.${key}`)) return t(`reason.${key}`);
      // Quarantine reasons, which activity rows name too.
      return t.has(`qr.${key}`) ? t(`qr.${key}`) : reason;
    })
    .join(" · ");
}

/** A thread message's own page: received mail under Inboxes, a send in the Emails log. */
export function messageHref(message: Pick<ThreadMessage, "id" | "direction">): string {
  return message.direction === "inbound"
    ? `/inboxes/received/${message.id}`
    : `/emails/${message.id}`;
}

/**
 * The message a thread's reply answers: the newest the inbox sent or let in.
 * Held mail (still screening, or quarantined) may carry a forged Reply-To, so
 * it is answered only from its own page, by choice.
 */
export function replyTarget(messages: readonly ThreadMessage[]): ThreadMessage | undefined {
  return messages.findLast(
    (message) =>
      message.direction === "outbound" ||
      (message.screening.verdict !== "pending" && message.screening.verdict !== "quarantined"),
  );
}

/**
 * Whom "Reply all" adds to a plain reply, as core's replyRecipients copies
 * them: the answered message's other recipients (its cc alone for a send of
 * the inbox's), never the inbox itself or whom the reply already goes to.
 */
export function replyAllAdds(
  message: Pick<ThreadMessage, "direction" | "from" | "to" | "cc" | "reply_to">,
  inbox: Pick<InboxDetail, "email_address" | "receiving_address">,
): string[] {
  const inbound = message.direction === "inbound";
  const replyTo = inbound
    ? message.reply_to.length > 0
      ? message.reply_to
      : [message.from]
    : message.to;
  const copied = inbound ? [...message.to, ...message.cc] : message.cc;
  const key = (mailbox: string) => addrSpec(mailbox).toLowerCase();
  const own = inbox.receiving_address
    ? [inbox.email_address, inbox.receiving_address]
    : [inbox.email_address];
  const seen = new Set([...own, ...replyTo].map(key));
  return copied.flatMap((mailbox) => {
    const address = key(mailbox);
    if (seen.has(address)) return [];
    seen.add(address);
    return [addrSpec(mailbox)];
  });
}

/** The inbox's kind as its tab names it. */
export function kindWord(t: ReturnType<typeof useTranslations>, kind: string): string {
  return t(kind === "human" ? "tabs.human" : "tabs.agent");
}

/** accept_from's choices, in the order every picker lists them. */
export const ACCEPT_FROM = [
  "anyone",
  "verified",
  "allowlist",
] as const satisfies readonly InboxSafety["accept_from"][];

/** What an accept_from choice lets in; "anyone" on a people inbox works like a plain mailbox. */
export function acceptFromHint(
  t: ReturnType<typeof useTranslations>,
  kind: string,
  value: InboxSafety["accept_from"],
): string {
  return t(`acceptFrom.${value === "anyone" && kind === "human" ? "anyoneHuman" : value}Hint`);
}

/**
 * Whether an accept_from choice shows the warning card: an agent acts on what
 * it reads, where a person judges it.
 */
export function acceptFromWarns(kind: string, value: InboxSafety["accept_from"]): boolean {
  return kind === "agent" && value === "anyone";
}
