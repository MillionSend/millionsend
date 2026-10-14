"use client";

import type { InboxSafety } from "@millionsend/db/schema";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import type { BadgeTone } from "@/components/status-badge";
import { Tooltip } from "@/components/tooltip";
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
