"use client";

import { holdRisk } from "@millionsend/core/release-rules";
import type { InboxSafety } from "@millionsend/db/schema";
import type { inferRouterOutputs } from "@trpc/server";
import { useLocale, useTranslations } from "next-intl";
import { EnvelopeGlyph } from "@/components/email-status-icon";
import type { BadgeTone } from "@/components/status-badge";
import { StatusTile, TONE_COLOR } from "@/components/status-tile";
import { Tooltip } from "@/components/tooltip";
import { addrSpec, capitalize, formatRelative } from "@/lib/format";
import { trpcErrorCode } from "@/lib/trpc-error";
import type { AppRouter } from "@/server/routers";

type Outputs = inferRouterOutputs<AppRouter>["inboxes"];
/** The inbox as its page reads it: the wire Inbox plus the dashboard's own facts. */
export type InboxDetail = Outputs["get"];
export type ThreadRow = Outputs["threads"]["list"]["items"][number];
export type ThreadMessage = Outputs["threads"]["emails"]["items"][number];
export type InboundScreening = Extract<ThreadMessage, { direction: "inbound" }>["screening"];
/** Held mail as the release dialog reads it, whichever screen opened it. */
export type QuarantinePreview = Outputs["quarantine"]["preview"];
/** A release's answer: delivered, or held again by the screening it ran first. */
export type ReleaseResult = Outputs["quarantine"]["release"];

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

/** The same as a list row's tile: tinted by the trust, its words in the tooltip. */
export function TrustTile({ trust }: { trust: SenderTrust }) {
  const t = useTranslations("inboxes");
  return (
    <StatusTile color={TONE_COLOR[TRUST_TONE[trust]]} label={t(`trust.${trust}`)}>
      <EnvelopeGlyph />
    </StatusTile>
  );
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
 * "Released by Ana Souza": held mail someone released (a person, a key or an
 * MCP client); why it was held, and when, in its tooltip.
 */
export function ReleasedBadge({
  screening,
  releasedAt,
}: {
  screening: InboundScreening;
  releasedAt: string;
}) {
  const t = useTranslations("inboxes");
  const locale = useLocale();
  const hold = holdOf(screening);
  const score = holdRisk(hold);
  const who = screening.released_by;
  // It ends a sentence, whose own period would double pt-BR's "há 2 min.".
  const time = formatRelative(releasedAt, locale).replace(/\.$/, "");
  const tip = [
    t("released.held", {
      code: hold.reason ?? "other",
      reason: hold.reason ? t(`qr.${hold.reason}`) : "",
      score: score === null ? "none" : String(score),
    }),
    who ? t("released.by", { who, time }) : t("released.at", { time }),
  ].join("\n");
  return (
    <Tooltip inline text={tip}>
      <span className="ms-badge ms-badge-warn">
        {who ? t("released.badge", { who }) : t("timeline.released")}
      </span>
    </Tooltip>
  );
}

/** What a hold rests on, as the thread wire, the Received page and the release dialog each carry it. */
interface Hold {
  reason: string | null;
  injectionScore: number | null;
  phishingScore: number | null;
  reasons: readonly string[];
}

/** A thread message's hold, as the other surfaces carry it. */
export function holdOf(screening: InboundScreening): Hold {
  return {
    reason: screening.quarantine_reason,
    injectionScore: screening.injection_score,
    phishingScore: screening.phishing_score,
    reasons: screening.reasons,
  };
}

/** The screening's reasons in words; a key with no words yet is left out. */
export function screeningReasonWords(
  t: ReturnType<typeof useTranslations>,
  reasons: readonly string[],
): string[] {
  return reasons.flatMap((key) =>
    t.has(`screeningReason.${key}`) ? [t(`screeningReason.${key}`)] : [],
  );
}

/**
 * Why mail is held, " · "-joined: its risk and the screening's reasons, led by
 * the reason itself where no badge beside the line names it. Empty when none
 * of that is known.
 */
export function heldWhy(
  t: ReturnType<typeof useTranslations>,
  hold: Hold,
  leadReason: boolean,
): string {
  const score = holdRisk(hold);
  const risk = score === null ? [] : [t("quarantine.risk", { score })];
  const words = screeningReasonWords(t, hold.reasons);
  const parts =
    leadReason && hold.reason
      ? [capitalize(t(`qr.${hold.reason}`)), ...risk, ...words]
      : [...risk.map(capitalize), ...words];
  return parts.join(" · ");
}

/**
 * A refused or failed release, or its preview, in words: the server's stable
 * message keys pick the copy, `fallback` words anything else.
 */
export function releaseErrorText(
  t: ReturnType<typeof useTranslations>,
  error: unknown,
  fallback: "quarantine.errors.failed" | "detail.error" = "quarantine.errors.failed",
): string {
  const key = (error as { message?: string } | null)?.message ?? "";
  if (t.has(`quarantine.errors.${key}`)) return t(`quarantine.errors.${key}`);
  return trpcErrorCode(error) === "NOT_FOUND" ? t("detail.notFound") : t(fallback);
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

/**
 * The shared domain's name review answering a create or an edit, in words,
 * or null for any other error. Its 422 and 429 share their codes with other
 * refusals, and its two 503s share one, so the API's message tells them
 * apart. orRandom: whether an address left empty, random and so never
 * reviewed, gets past it.
 */
export function nameReviewError(
  t: ReturnType<typeof useTranslations>,
  error: unknown,
): { text: string; orRandom: boolean } | null {
  const code = trpcErrorCode(error);
  const message = (error as { message?: string } | null)?.message ?? "";
  if (code === "SERVICE_UNAVAILABLE") {
    // The team's subdomain itself waits for its name review: a random address waits too.
    return message.startsWith("Your team's subdomain")
      ? { text: t("create.errors.sharedPending"), orRandom: false }
      : { text: t("create.errors.reviewUnavailable"), orRandom: true };
  }
  // The name review's daily budgets, of refused names and of reviews.
  if (code === "TOO_MANY_REQUESTS" && message.startsWith("Too many names were")) {
    return { text: t("create.errors.tooManyNames"), orRandom: true };
  }
  if (code === "UNPROCESSABLE_CONTENT" && message.includes("can't be used on the shared domain")) {
    return { text: t("create.errors.nameRefused"), orRandom: true };
  }
  return null;
}

/** accept_from's choices, in the order every picker lists them. */
export const ACCEPT_FROM = [
  "anyone",
  "verified",
  "allowlist",
] as const satisfies readonly InboxSafety["accept_from"][];

/**
 * What an accept_from choice lets in; "anyone" on a people inbox works like a
 * plain mailbox, and the shared domain ignores owner addresses.
 */
export function acceptFromHint(
  t: ReturnType<typeof useTranslations>,
  kind: string,
  shared: boolean,
  value: InboxSafety["accept_from"],
): string {
  return t(`acceptFrom.${value === "anyone" && kind === "human" ? "anyoneHuman" : value}Hint`, {
    shared: shared ? "yes" : "no",
  });
}

/**
 * Whether an accept_from choice shows the warning card: an agent acts on what
 * it reads, where a person judges it.
 */
export function acceptFromWarns(kind: string, value: InboxSafety["accept_from"]): boolean {
  return kind === "agent" && value === "anyone";
}
