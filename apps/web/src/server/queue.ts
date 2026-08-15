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
