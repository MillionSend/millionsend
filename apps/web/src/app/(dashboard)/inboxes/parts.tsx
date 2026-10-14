"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import type { BadgeTone } from "@/components/status-badge";
import { trpcErrorCode } from "@/lib/trpc-error";
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

/**
 * What holds a shared-domain inbox back from starting conversations: its
 * team's plan, the instance, or sending paused outright; null when nothing
 * does or the inbox is on a team's own domain. No mode reads as replies only,
 * as core's safety rules read it.
 */
export function sharedModeKey(inbox: {
  shared: boolean;
  sharedSending?: { mode: string; cause: string | null } | null | undefined;
}): "plan" | "instance" | "paused" | null {
  const s = inbox.sharedSending;
  if (!inbox.shared || s?.mode === "open") return null;
  return s?.mode === "receive_only" ? "paused" : s?.cause === "plan" ? "plan" : "instance";
}

/**
 * The shared domain's name review answering a create or an edit, in words,
 * or null for any other error. Its 422 and 429 share their codes with other
 * refusals, so the API's message tells them apart.
 */
export function nameReviewError(
  t: ReturnType<typeof useTranslations>,
  error: unknown,
): string | null {
  const code = trpcErrorCode(error);
  const message = (error as { message?: string } | null)?.message ?? "";
  if (code === "SERVICE_UNAVAILABLE") return t("create.errors.reviewUnavailable");
  // The name review's daily budgets, of refused names and of reviews.
  if (code === "TOO_MANY_REQUESTS" && message.startsWith("Too many names were")) {
    return t("create.errors.tooManyNames");
  }
  if (code === "UNPROCESSABLE_CONTENT" && message.includes("can't be used on the shared domain")) {
    return t("create.errors.nameRefused");
  }
  return null;
}
