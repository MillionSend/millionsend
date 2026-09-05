import { env } from "@millionsend/config";
import { hashRecipient, type WebhookEnqueue } from "@millionsend/core";
import { EMAIL_SEND_PRIORITY, Queue } from "@millionsend/queue";

let instance: Promise<Queue> | undefined;

/**
 * Lazy singleton, mirroring getDb: importing this module must not open a
 * queue connection — pg-boss only starts on the first enqueue.
 */
export function getQueue(): Promise<Queue> {
  // A rejected start is dropped so the next caller retries instead of
  // inheriting one transient failure for the life of the process.
  instance ??= Queue.start(env.DATABASE_URL).catch((err: unknown) => {
    instance = undefined;
    throw err;
  });
  return instance;
}

/** Enqueue an email.send job from the web tier (the onboarding send); mirrors the API's seam. */
export async function enqueueEmailSend(emailId: string): Promise<void> {
  const queue = await getQueue();
  await queue.send(
    "email.send",
    { emailId },
    { dedupeKey: emailId, priority: EMAIL_SEND_PRIORITY.transactional },
  );
}

/**
 * Enqueue webhook.deliver jobs from the web tier in one statement (the worker
 * owns the matching seam in its server bootstrap). dedupeKey collapses a
 * redelivery of the same delivery row onto one queued job; the endpoint is
 * the fairness group the delivery lanes cap.
 */
export const enqueueWebhookDeliveries: WebhookEnqueue = async (deliveries) => {
  if (deliveries.length === 0) return;
  const queue = await getQueue();
  await queue.sendMany(
    "webhook.deliver",
    deliveries.map((d) => ({
      payload: { deliveryId: d.id },
      dedupeKey: d.id,
      group: d.endpointId,
    })),
  );
};

/** Scrub one address from the team's history in the worker, after its contact row is gone. */
export async function enqueueRecipientErase(teamId: string, address: string): Promise<void> {
  const queue = await getQueue();
  await queue.send(
    "recipient.erase",
    { teamId, address },
    { dedupeKey: `${teamId}:${hashRecipient(address)}` },
  );
}
