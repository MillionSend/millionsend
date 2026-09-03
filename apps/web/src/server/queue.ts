import { env } from "@millionsend/config";
import { Queue } from "@millionsend/queue";

let instance: Promise<Queue> | undefined;

/**
 * Lazy singleton, mirroring getDb: importing this module must not open a
 * queue connection — pg-boss only starts on the first enqueue.
 */
export function getQueue(): Promise<Queue> {
  instance ??= Queue.start(env.DATABASE_URL);
  return instance;
}

/** Enqueue an email.send job from the web tier (the onboarding send); mirrors the API's seam. */
export async function enqueueEmailSend(emailId: string): Promise<void> {
  const queue = await getQueue();
  await queue.send("email.send", { emailId }, { dedupeKey: emailId });
}

/**
 * Enqueue a webhook.deliver job from the web tier (the worker owns the
 * matching seam in its server bootstrap). dedupeKey collapses a redelivery of
 * the same delivery row onto one queued job.
 */
export async function enqueueWebhookDelivery(deliveryId: string): Promise<void> {
  const queue = await getQueue();
  await queue.send("webhook.deliver", { deliveryId }, { dedupeKey: deliveryId });
}
