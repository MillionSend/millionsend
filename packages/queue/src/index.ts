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
  // Cross-table scrub of one address after its contact was deleted; too slow
  // for a request on a large team, so it runs here.
  "recipient.erase": { teamId: string; address: string };
}

/** ParsedSesEvent with occurredAt as ISO string (JSON-safe). */
export interface SerializedSesEvent {
  eventType: string;
  sesMessageId: string;
  emailId?: string;
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
 * Fetch order inside the email.send queue: pg-boss serves the higher priority
 * first, then the older job. A transactional email (API, SMTP relay,
 * onboarding) must never wait behind a broadcast fan-out or a quota drain of
 * one, so bulk mail enqueues at 0 and transactional at 1.
 */
export const EMAIL_SEND_PRIORITY = { transactional: 1, bulk: 0 } as const;
export type EmailSendPriority = (typeof EMAIL_SEND_PRIORITY)[keyof typeof EMAIL_SEND_PRIORITY];

/** The priority an existing email row re-enqueues with: broadcast rows are bulk, everything else transactional. */
export const emailSendPriority = (email: { broadcastId: string | null }): EmailSendPriority =>
  email.broadcastId ? EMAIL_SEND_PRIORITY.bulk : EMAIL_SEND_PRIORITY.transactional;

/**
 * Job queues use the "short" policy: pg-boss only enforces singletonKey
 * uniqueness under short/singleton/stately/exclusive policies — on the
 * default "standard" policy the key is silently ignored and dedupe would be
 * a no-op. "short" + a key on every send = at most one QUEUED job per key
 * (unlimited active), which is exactly the redelivery-collapse semantic.
 */
const JOB_QUEUE_POLICY = "short" as const;

/**
 * Jobs that exhaust their retries are copied here instead of vanishing: the
 * dead-letter handler turns "gave up" into a terminal row state (email
 * failed, delivery exhausted) so the reconcile sweeps stop re-enqueueing
 * them. pg-boss enforces a FK from job.dead_letter to the queue table, so
 * the dead-letter queue must exist before the first send.
 */
export const DEAD_LETTER_QUEUES = {
  "email.send": "email.send.dead",
  "webhook.deliver": "webhook.deliver.dead",
  "recipient.erase": "recipient.erase.dead",
} as const;

export type DeadLetteredJobName = keyof typeof DEAD_LETTER_QUEUES;

/**
 * Jobs allowed to stay active longer than pg-boss's 15-minute default before
 * it retries them under a still-running handler. A broadcast fan-out walks
 * every contact in one job; an erasure scans a team's whole history.
 */
const EXPIRE_SECONDS: Partial<Record<JobName, number>> = {
  "broadcast.send": 6 * 3600,
  // Longest pg-boss allows short of a day: the handler does not watch the
  // abort signal, so an expiry must never fire under a scan still running.
  "recipient.erase": 23 * 3600,
};

/**
 * Finished jobs are history the queue never reads again; an hour keeps the
 * table small enough that the supervisor's per-minute counts stay cheap.
 */
const DELETE_AFTER_SECONDS = 3600;

const JOB_RETRY = { retryLimit: 10, retryBackoff: true, retryDelay: 5 } as const;

export const CRON_JOBS = {
  // Every 15 min: quota-parked emails drain back into the send queue as the
  // plan's UTC day rolls over or SES's rolling 24-hour window frees up.
  "quota.drain": "*/15 * * * *",
  // Every 15 min: re-enqueue accepted emails whose send job was lost.
  "sends.reconcile": "*/15 * * * *",
  // Hourly retention sweeps keep purge batches small.
  "retention.purge": "0 * * * *",
  "idempotency.purge": "30 * * * *",
  // Every 15 min: re-enqueue webhook deliveries whose job was lost.
  "webhooks.reconcile": "*/15 * * * *",
  // Every 15 min: re-enqueue broadcasts stuck in scheduled/sending.
  "broadcasts.reconcile": "*/15 * * * *",
  // Every 30 min: refresh the cached contact counts the Segments page shows.
  "segments.recount": "*/30 * * * *",
  // Every 15 min: re-check live DNS so a removed record demotes a verified
  // domain (blocking sends) without waiting for a page open.
  "domains.reverify": "*/15 * * * *",
  // Every 10 min: quota and deliverability notifications to team owners.
  "notifications.sweep": "*/10 * * * *",
  // Every 15 min: per-region platform breaker on the account-wide bounce/complaint rates.
  "platform.breaker": "*/15 * * * *",
  // Every 15 min: warn when sends went out but no SES event came back — a
  // broken event pipeline is otherwise silent (everything just reads "Sent").
  "events.health": "*/15 * * * *",
  // Hourly: associate domains with their team's SES tenant where the create-time
  // association is missing (pre-tenant rows, or a failed AWS call).
  "tenants.sync": "17 * * * *",
  // Hourly (cloud only): drop never-verified domains past SES's 72h DKIM
  // search window, freeing the (name, region) slot an unverified add would
  // otherwise squat forever. Offset from the other hourly sweeps.
  "domains.reap": "45 * * * *",
  // Daily: re-read each Stripe customer's subscription so a dropped webhook
  // cannot leave a team on the wrong plan. No-op off cloud.
  "billing.reconcile": "20 3 * * *",
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

function deadLetterFor(name: JobName): string | undefined {
  return name in DEAD_LETTER_QUEUES ? DEAD_LETTER_QUEUES[name as DeadLetteredJobName] : undefined;
}

/**
 * `dedupeKey` is REQUIRED: on the short-policy queues it is the singletonKey
 * that collapses duplicates while a job is queued. `startAfter` defers the
 * job; `group` names the fairness group a worker's groupConcurrency caps.
 */
export interface JobSendOptions {
  dedupeKey: string;
  startAfter?: Date | undefined;
  priority?: number | undefined;
  group?: string | undefined;
}

export class Queue {
  #boss: PgBoss;
  #created = new Set<string>();

  private constructor(boss: PgBoss) {
    this.#boss = boss;
  }

  static async start(databaseUrl: string): Promise<Queue> {
    // Maintenance every 10 minutes deletes finished jobs in small slices
    // instead of one daily statement; four connections cover every fetch and
    // completion, which are millisecond statements.
    const boss = new PgBoss({
      connectionString: databaseUrl,
      schema: "pgboss",
      maintenanceIntervalSeconds: 600,
      max: 4,
    });
    boss.on("error", (err: Error) => console.error("pg-boss error", err));
    await boss.start();
    return new Queue(boss);
  }

  async #ensureQueue(name: string, policy?: typeof JOB_QUEUE_POLICY): Promise<void> {
    if (this.#created.has(name)) return;
    await this.#boss.createQueue(name, policy ? { policy } : undefined).catch(() => {});
    if (policy) {
      // createQueue is INSERT ... ON CONFLICT DO NOTHING: a pre-existing
      // queue keeps its stored policy, and pg-boss 12 cannot converge it —
      // updateQueue() throws "queue policy cannot be changed after creation"
      // (its UpdateQueueOptions omits `policy`). A queue left on "standard"
      // silently ignores singletonKey, turning dedupe into duplicate sends,
      // so a mismatch must fail loudly instead of degrading silently.
      const existing = await this.#boss.getQueue(name);
      if (existing && existing.policy !== policy) {
        throw new Error(
          `queue "${name}" has policy "${existing.policy}" but "${policy}" is required for ` +
            `singletonKey dedupe; pg-boss cannot change a queue's policy after creation — ` +
            `delete and recreate the queue`,
        );
      }
    }
    this.#created.add(name);
  }

  /** Enqueue one job; see JobSendOptions. */
  async send<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts: JobSendOptions,
  ): Promise<string | null> {
    const deadLetter = await this.#prepare(name);
    return this.#boss.send(name, payload, this.#jobOptions(name, opts, deadLetter));
  }

  /**
   * Enqueue many jobs of one queue in a single statement: a webhook fan-out
   * writes one job per endpoint, and a bulk import many per contact.
   */
  async sendMany<N extends JobName>(
    name: N,
    jobs: readonly (JobSendOptions & { payload: JobPayloads[N] })[],
  ): Promise<void> {
    if (jobs.length === 0) return;
    const deadLetter = await this.#prepare(name);
    await this.#boss.insert(
      name,
      jobs.map(({ payload, ...opts }) => ({
        data: payload,
        ...this.#jobOptions(name, opts, deadLetter),
      })),
    );
  }

  async #prepare(name: JobName): Promise<string | undefined> {
    await this.#ensureQueue(name, JOB_QUEUE_POLICY);
    const deadLetter = deadLetterFor(name);
    if (deadLetter) await this.#ensureQueue(deadLetter);
    return deadLetter;
  }

  #jobOptions(name: JobName, opts: JobSendOptions, deadLetter: string | undefined) {
    const expireInSeconds = EXPIRE_SECONDS[name];
    return {
      singletonKey: opts.dedupeKey,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.group ? { group: { id: opts.group } } : {}),
      ...(deadLetter ? { deadLetter } : {}),
      ...(expireInSeconds ? { expireInSeconds } : {}),
      deleteAfterSeconds: DELETE_AFTER_SECONDS,
      ...JOB_RETRY,
    };
  }

  /**
   * `concurrency` spawns that many independent pg-boss workers for the queue
   * in this process, so one slow job (a stalling webhook receiver) cannot
   * serialize everyone else's. It is not a rate limit.
   *
   * A worker sleeps `pollingIntervalSeconds` (pg-boss default 2) between
   * fetches unless the last fetch came back full, and a batch of one never
   * counts as full: at batchSize 1 each worker moves at most one job every
   * two seconds however long the backlog. Queues that see bursts fetch a
   * `batchSize` above one, which turns on continuous fetching while the
   * backlog lasts; the handler still runs the batch one job at a time.
   */
  async work<N extends JobName>(
    name: N,
    handler: (payload: JobPayloads[N]) => Promise<void>,
    opts: {
      batchSize?: number;
      concurrency?: number;
      pollingIntervalSeconds?: number;
      /**
       * Cap on jobs of one `group` (see JobSendOptions) running at once across
       * every worker process, enforced in the fetch itself, so one slow
       * receiver cannot occupy every lane and no fetched job waits on an
       * in-memory limiter.
       */
      groupConcurrency?: number;
    } = {},
  ): Promise<void> {
    await this.#ensureQueue(name, JOB_QUEUE_POLICY);
    const batchSize = opts.batchSize ?? 1;
    await this.#boss.work<JobPayloads[N]>(
      name,
      {
        batchSize,
        localConcurrency: opts.concurrency ?? 1,
        burstWhenBatchFull: batchSize > 1,
        ...(opts.pollingIntervalSeconds !== undefined
          ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
          : {}),
        ...(opts.groupConcurrency !== undefined ? { groupConcurrency: opts.groupConcurrency } : {}),
      },
      async (jobs: { data: JobPayloads[N] }[]) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      },
    );
  }

  /** Handles jobs that exhausted their retries on `name` (payload unchanged). */
  async workDeadLetter<N extends DeadLetteredJobName>(
    name: N,
    handler: (payload: JobPayloads[N]) => Promise<void>,
  ): Promise<void> {
    const deadLetter = DEAD_LETTER_QUEUES[name];
    await this.#ensureQueue(deadLetter);
    await this.#boss.work<JobPayloads[N]>(
      deadLetter,
      { batchSize: 1 },
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

  /**
   * Runs a cron job ahead of its schedule. Cron queues use the standard
   * policy, so a run already queued is not collapsed; every cron handler is
   * idempotent, so an extra run only costs a query.
   */
  async runCronNow(name: CronJobName): Promise<void> {
    await this.#ensureQueue(name);
    await this.#boss.send(name, {});
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true });
  }
}
