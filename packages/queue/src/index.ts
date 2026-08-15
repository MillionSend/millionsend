import { PgBoss } from "pg-boss";

/**
 * Thin, typed wrapper over pg-boss — the seam behind which Redis/BullMQ can
 * arrive later without touching product code (stack decision §0). Job
 * payloads are minimal references; workers re-read authoritative state from
 * Postgres — a payload is never trusted as truth.
 */

export interface JobPayloads {
  "email.send": { emailId: string };
  "broadcast.send": { broadcastId: string };
  // snsMessageId rides along for durable idempotency in the handler; queue
  // dedupe alone cannot cover an SNS redelivery after the job completed.
  "ses.event": { event: SerializedSesEvent; snsMessageId: string };
  "webhook.deliver": { deliveryId: string };
}

/** ParsedSesEvent with occurredAt as ISO string (JSON-safe). */
export interface SerializedSesEvent {
  eventType: string;
  sesMessageId: string;
  occurredAt: string;
  bounce?: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bounceSubType: string;
    recipients: string[];
    diagnosticCode?: string;
  };
  complaint?: { complaintFeedbackType?: string; recipients: string[] };
  delivery?: { smtpResponse?: string; processingTimeMillis?: number };
  click?: { link?: string };
  data: Record<string, unknown>;
}

export type JobName = keyof JobPayloads;

/**
 * Job queues use the "short" policy: pg-boss only enforces singletonKey
 * uniqueness under short/singleton/stately/exclusive policies — on the
 * default "standard" policy the key is silently ignored and dedupe would be
 * a no-op. "short" + a key on every send = at most one QUEUED job per key
 * (unlimited active), which is exactly the redelivery-collapse semantic.
 */
const JOB_QUEUE_POLICY = "short" as const;

export const CRON_JOBS = {
  // Midnight UTC: quota-parked emails drain back into the send queue.
  "quota.drain": "0 0 * * *",
  // Every 15 min: re-enqueue accepted emails whose send job was lost.
  "sends.reconcile": "*/15 * * * *",
  // Hourly retention sweeps keep purge batches small.
  "retention.purge": "0 * * * *",
  "idempotency.purge": "30 * * * *",
  // Every 15 min: re-enqueue webhook deliveries whose job was lost.
  "webhooks.reconcile": "*/15 * * * *",
  // Every 15 min: re-enqueue broadcasts stuck in scheduled/sending.
  "broadcasts.reconcile": "*/15 * * * *",
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

export class Queue {
  #boss: PgBoss;
  #created = new Set<string>();

  private constructor(boss: PgBoss) {
    this.#boss = boss;
  }

  static async start(databaseUrl: string): Promise<Queue> {
    const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
    boss.on("error", (err: Error) => console.error("pg-boss error", err));
    await boss.start();
    return new Queue(boss);
  }

  async #ensureQueue(name: string, policy?: typeof JOB_QUEUE_POLICY): Promise<void> {
    if (this.#created.has(name)) return;
    await this.#boss.createQueue(name, policy ? { policy } : undefined).catch(() => {});
    this.#created.add(name);
  }

  /**
   * Enqueue a job. `dedupeKey` is REQUIRED: on the short-policy queues it is
   * the singletonKey that collapses duplicates while a job is queued.
   * `startAfter` defers the job (scheduled sends).
   */
  async send<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts: { dedupeKey: string; startAfter?: Date },
  ): Promise<string | null> {
    await this.#ensureQueue(name, JOB_QUEUE_POLICY);
    return this.#boss.send(name, payload, {
      singletonKey: opts.dedupeKey,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      retryLimit: 10,
      retryBackoff: true,
      retryDelay: 5,
    });
  }

  async work<N extends JobName>(
    name: N,
    handler: (payload: JobPayloads[N]) => Promise<void>,
    opts: { batchSize?: number } = {},
  ): Promise<void> {
    await this.#ensureQueue(name, JOB_QUEUE_POLICY);
    await this.#boss.work<JobPayloads[N]>(
      name,
      { batchSize: opts.batchSize ?? 1 },
      async (jobs: { data: JobPayloads[N] }[]) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      },
    );
  }

  async scheduleCrons(handlers: Record<CronJobName, () => Promise<void>>): Promise<void> {
    for (const [name, cron] of Object.entries(CRON_JOBS) as [CronJobName, string][]) {
      await this.#ensureQueue(name);
      await this.#boss.schedule(name, cron, {}, { tz: "UTC" });
      await this.#boss.work(name, { batchSize: 1 }, async () => {
        await handlers[name]();
      });
    }
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true });
  }
}
