"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import type { BadgeTone } from "@/components/status-badge";
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
      return t.has(`reason.${key}`) ? t(`reason.${key}`) : reason;
    })
    .join(" · ");
}

/** The inbox's kind as its tab names it. */
export function kindWord(t: ReturnType<typeof useTranslations>, kind: string): string {
  return t(kind === "human" ? "tabs.human" : "tabs.agent");
}
