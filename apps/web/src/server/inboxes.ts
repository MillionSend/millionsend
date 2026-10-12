import { env, isCloudDeployment, receivingEnabled, sharedInboxDomain } from "@millionsend/config";
import {
  deriveInboxKeys,
  fetchEffectivePlan,
  type InboxActor,
  type InboxDeps,
  type InboxError,
  type InboxSendDeps,
  PLAN_INBOX_LIMIT,
  type SendOutcome,
  type WebhookEnqueue,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, count, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { parseInboxActor } from "@/lib/inbox-actor";
import { getKeyring } from "./keyring";
import { enqueueInboxForward } from "./queue";

/** The dashboard acts as the signed-in person, who may approve held sends and release quarantine. */
export function userActor(ctx: { session: { user: { id: string } } }): InboxActor {
  return { kind: "user", userId: ctx.session.user.id };
}

interface Enqueues {
  enqueueEmailSend?: ((emailId: string) => Promise<void>) | undefined;
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
}

export function inboxDeps(ctx: Enqueues): InboxDeps {
  return {
    sharedInboxDomain: sharedInboxDomain() ?? null,
    receivingEnabled: receivingEnabled(),
    enqueueWebhookDeliveries: ctx.enqueueWebhookDeliveries,
  };
}

export function inboxSendDeps(ctx: Enqueues & { db: Db }): InboxSendDeps {
  return {
    db: ctx.db,
    keyring: getKeyring(),
    isCloud: isCloudDeployment(),
    // Absent in tests: the reconcile sweep re-enqueues accepted rows.
    enqueueEmailSend: ctx.enqueueEmailSend ?? (async () => {}),
    inboxKeys: deriveInboxKeys(Buffer.from(env.MASTER_ENCRYPTION_KEY ?? "", "base64")),
    sharedInboxDomain: sharedInboxDomain() ?? null,
    enqueueWebhookDeliveries: ctx.enqueueWebhookDeliveries,
  };
}

const TRPC_CODE = {
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
} as const;

/** A core refusal as a dashboard error: its status picks the code, the API's message rides along. */
export function inboxFailure(error: InboxError): TRPCError {
  return new TRPCError({ code: TRPC_CODE[error.status], message: error.message });
}

/** What a reply, forward, new send or approval did: sent, or held as a draft for a person. */
export function sendResult(outcome: SendOutcome) {
  if (outcome.kind === "refused") throw inboxFailure(outcome.error);
  return outcome.kind === "sent"
    ? { kind: "sent" as const, emailId: outcome.email.email_id, threadId: outcome.threadId }
    : {
        kind: "draft" as const,
        draftId: outcome.draft.id,
        reasons: outcome.draft.approval_reasons,
      };
}

/**
 * The release is committed by the time its forward is queued; a queue
 * outage must not read as a failed release.
 */
export async function forwardQuietly(p: { receivedEmailId: string; inboxId: string }) {
  try {
    await enqueueInboxForward(p);
  } catch (err) {
    console.error("inbox.forward enqueue failed after a release", err);
  }
}

export function releaseFailure(reason: "not_found" | "not_quarantined" | "allowlist_full") {
  return reason === "not_found"
    ? new TRPCError({ code: "NOT_FOUND" })
    : reason === "not_quarantined"
      ? new TRPCError({ code: "CONFLICT", message: reason })
      : new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: reason });
}

/** Names behind encoded actors, read in one query per kind; a deleted one keeps no name. */
export async function actorNames(db: Db, teamId: string, encoded: string[]) {
  const actors = encoded.map(parseInboxActor);
  const ids = (kind: string, pick: (a: ReturnType<typeof parseInboxActor>) => string | null) => [
    ...new Set(actors.filter((a) => a.kind === kind).flatMap((a) => pick(a) ?? [])),
  ];
  const userIds = ids("user", (a) => (a.kind === "user" ? a.userId : null));
  const keyIds = ids("api_key", (a) => (a.kind === "api_key" ? a.apiKeyId : null));
  const clientIds = ids("oauth", (a) => (a.kind === "oauth" ? a.clientId : null));
  const [users, keys, clients] = await Promise.all([
    userIds.length
      ? db
          .select({ id: schema.user.id, name: schema.user.name })
          .from(schema.user)
          .where(inArray(schema.user.id, userIds))
      : [],
    keyIds.length
      ? db
          .select({ id: schema.apiKeys.id, name: schema.apiKeys.name })
          .from(schema.apiKeys)
          .where(and(eq(schema.apiKeys.teamId, teamId), inArray(schema.apiKeys.id, keyIds)))
      : [],
    clientIds.length
      ? db
          .select({ id: schema.oauthClient.clientId, name: schema.oauthClient.name })
          .from(schema.oauthClient)
          .where(inArray(schema.oauthClient.clientId, clientIds))
      : [],
  ]);
  const names = new Map<string, string | null>([
    ...users.map((u) => [`user:${u.id}`, u.name] as const),
    ...keys.map((k) => [`api_key:${k.id}`, k.name] as const),
    ...clients.map((c) => [`oauth:${c.id}`, c.name] as const),
  ]);
  return actors.map((a) => {
    const key =
      a.kind === "user"
        ? `user:${a.userId}`
        : a.kind === "api_key"
          ? `api_key:${a.apiKeyId}`
          : a.kind === "oauth"
            ? `oauth:${a.clientId}`
            : "";
    return { kind: a.kind, name: names.get(key) ?? null };
  });
}

/** Catch-all receiving is a paid feature on cloud; self-host has no plans. */
export async function catchAllAllowed(db: Db, teamId: string): Promise<boolean> {
  return !isCloudDeployment() || ((await fetchEffectivePlan(db, teamId)) ?? "free") !== "free";
}

export const liveInbox = (now: Date) =>
  or(isNull(schema.inboxes.expiresAt), gt(schema.inboxes.expiresAt, now));

/** The team's live inboxes against its plan's cap; no limit off cloud or on uncapped plans. */
export async function planUsage(db: Db, teamId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(schema.inboxes)
    .where(and(eq(schema.inboxes.teamId, teamId), liveInbox(new Date())));
  const plan = isCloudDeployment() ? ((await fetchEffectivePlan(db, teamId)) ?? "free") : null;
  return { used: row?.n ?? 0, limit: plan ? PLAN_INBOX_LIMIT[plan] : null };
}
