import PgBoss from "pg-boss";

/**
 * Thin, typed wrapper over pg-boss — the seam behind which Redis/BullMQ can
 * arrive later without touching product code (stack decision §0). Job
 * payloads are minimal references; workers re-read authoritative state from
 * Postgres — a payload is never trusted as truth.
 */

export interface JobPayloads {
  "email.send": { emailId: string };
  "ses.event": { event: SerializedSesEvent };
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

export const CRON_JOBS = {
  // Midnight UTC: quota-parked emails drain back into the send queue.
  "quota.drain": "0 0 * * *",
  // Hourly retention sweeps keep purge batches small.
  "retention.purge": "0 * * * *",
  "idempotency.purge": "30 * * * *",
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

export class Queue {
  #boss: PgBoss;

  private constructor(boss: PgBoss) {
    this.#boss = boss;
  }

  static async start(databaseUrl: string): Promise<Queue> {
    const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
    boss.on("error", (err) => console.error("pg-boss error", err));
    await boss.start();
    return new Queue(boss);
  }

  /**
   * Enqueue a job. `dedupeKey` (pg-boss singletonKey) makes redelivered SNS
   * messages collapse into one job while one is queued/active.
   */
  async send<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts: { dedupeKey?: string } = {},
  ): Promise<string | null> {
    await this.#boss.createQueue(name).catch(() => {});
    return this.#boss.send(name, payload, {
      ...(opts.dedupeKey ? { singletonKey: opts.dedupeKey } : {}),
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
    await this.#boss.createQueue(name).catch(() => {});
    await this.#boss.work<JobPayloads[N]>(
      name,
      { batchSize: opts.batchSize ?? 1 },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      },
    );
  }

  async scheduleCrons(handlers: Record<CronJobName, () => Promise<void>>): Promise<void> {
    for (const [name, cron] of Object.entries(CRON_JOBS) as [CronJobName, string][]) {
      await this.#boss.createQueue(name).catch(() => {});
      await this.#boss.schedule(name, cron, {}, { tz: "UTC" });
      await this.#boss.work(name, { batchSize: 1 }, async () => {
        await handlers[name]();
      });
    }
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true, wait: true });
  }
}
